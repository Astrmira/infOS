import { describe, expect, it, vi } from 'vitest'
import { TaskControlService } from '@infos/backend/services/task/taskControlService'
import { readTaskLifecycle } from '@infos/backend/services/task/taskLifecycle'
import { manageTaskTool } from '@infos/backend/tools/taskControl'
import { setTaskToolRuntime } from '@infos/backend/tools/taskControl/runtime'

function setup() {
  const task = {
    id: 'task',
    agentId: 'pero',
    revision: 1,
    title: '整理资料',
    instruction: '整理资料',
    status: 'completed',
    category: 'agent_task',
    lifecycle: readTaskLifecycle(null, '整理资料'),
    result: '甲'.repeat(20000),
    parentTaskId: null as string | null,
  }
  const tasks = {
    dispatch: vi.fn(async (_input: { idempotencyKey?: string }) => task),
    getTask: vi.fn(async () => task),
    query: vi.fn(async () => ({ items: [task], total: 1 })),
    changeTask: vi.fn(),
  }
  const service = new TaskControlService(
    tasks as never,
    {} as never,
    {} as never,
    async () => 'pero',
  )
  return { task, tasks, service }
}

describe('统一任务控制入口', () => {
  it('主线交办成功即可发表受理回执；侧线只返回任务资料，派发失败不发表', async () => {
    const { service, tasks, task } = setup()
    task.status = 'queued'
    const publish = vi.fn(async () => ({ messageId: 12 }))
    const context = { agentId: 'pero', sessionId: 'origin', threadId: 'origin', source: 'desktop', channel: 'desktop' }
    const main = { ...context, conversation: { publish, assertCurrent() {}, wait: async () => [], resolve: async () => {} } }
    const input = { action: 'create', instruction: '整理资料', message: '我去整理，等会儿把清单给你。' }
    setTaskToolRuntime({ control: (agent, args, thread, ctx) =>
      service.execute(agent, args, undefined, false, thread, ctx),
      submitSegment: async () => {}, beforeTool: async () => {}, afterTool: async () => {} })
    try {
      expect(await manageTaskTool.execute(input, main)).toMatchObject({
        ok: true, shouldTerminate: true, metadata: { conversationMessage: { messageId: 12, content: input.message } },
      })
      expect(JSON.parse(String(await manageTaskTool.execute(input, context)))).toMatchObject({ id: 'task' })
      tasks.dispatch.mockRejectedValueOnce(new Error('派发失败'))
      await expect(manageTaskTool.execute(input, main)).rejects.toThrow('派发失败')
      expect(publish).toHaveBeenCalledExactlyOnceWith({ id: 'dispatch-task', content: input.message })
    } finally {
      setTaskToolRuntime(undefined)
    }
  })
  it('桌面派发绑定原会话并开启结果回填，重试使用稳定工具调用身份', async () => {
    const { tasks, service } = setup()
    await service.execute(
      'pero',
      { action: 'create', instruction: '整理资料' },
      undefined,
      false,
      'origin',
      { callId: 'call-1' },
    )
    expect(tasks.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        targetThreadId: 'origin',
        completionAction: 'send_to_chat',
        metadata: { originThreadId: 'origin' },
        idempotencyKey: 'tool:pero:origin:call-1',
      }),
    )
  })

  it('完整结果分页读取，返回后续偏移而非丢失截断部分', async () => {
    const { service } = setup()
    expect(
      await service.execute('pero', {
        action: 'get',
        taskId: 'task',
        resultOffset: 11999,
        resultLimit: 8000,
      }),
    ).toMatchObject({ result: '甲'.repeat(8000), resultTotalChars: 20000, nextResultOffset: 19999 })
    expect(
      await service.execute('pero', { action: 'get', taskId: 'task', resultOffset: 19999 }),
    ).toMatchObject({ result: '甲', nextResultOffset: null })
  })

  it('后台任务不能通过统一入口再创建通用任务', async () => {
    const { service, tasks } = setup()
    await expect(
      service.execute(
        'pero',
        { action: 'create', instruction: '另开任务写代码' },
        undefined,
        false,
        'background',
        { taskId: 'parent', executionId: 'execution' },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(tasks.dispatch).not.toHaveBeenCalled()
  })

  it('后台任务仍可读取自身和管理关联的社交交办', async () => {
    const { service, tasks, task } = setup()
    const context = { taskId: 'task', executionId: 'execution' }
    expect(
      await service.execute(
        'pero',
        { action: 'get', taskId: 'task' },
        undefined,
        false,
        'background',
        context,
      ),
    ).toMatchObject({ id: 'task' })
    task.parentTaskId = 'task'
    task.id = 'social-task'
    task.status = 'running'
    await service.execute(
      'pero',
      { action: 'cancel', taskId: 'social-task', expectedRevision: 1 },
      undefined,
      false,
      'background',
      context,
    )
    expect(tasks.changeTask).toHaveBeenCalledWith('social-task', 1, {
      action: 'cancel',
      taskId: 'social-task',
      expectedRevision: 1,
    })
  })

  it('后台执行不能操作自身或其他父任务的子任务', async () => {
    const { service, tasks } = setup()
    await expect(
      service.execute(
        'pero',
        { action: 'cancel', taskId: 'task', expectedRevision: 1 },
        undefined,
        false,
        'background',
        { taskId: 'task', executionId: 'execution' },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(
      service.execute('pero', { action: 'get', taskId: 'task' }, undefined, false, 'background', {
        taskId: 'another-parent',
        executionId: 'execution',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(tasks.changeTask).not.toHaveBeenCalled()
  })

  it('不同平台已核验的主人能读取同一人格任务，结果投递仍保留原来源', async () => {
    const { service, task } = setup()
    const origin = {
      platform: 'qq',
      accountId: 'bot',
      senderId: 'owner',
      channelType: 'private' as const,
      channelId: 'dm',
      messageId: 'message',
    }
    task.lifecycle.origin = origin
    expect(
      await service.remote({ ...origin, platform: 'telegram' }, { action: 'get', taskId: 'task' }),
    ).toMatchObject({ agentId: 'pero', lifecycle: { origin } })
  })

  it('同一社交消息的两个派发动作使用各自的幂等键', async () => {
    const { service, tasks } = setup()
    const origin = {
      platform: 'qq',
      accountId: 'bot',
      senderId: 'owner',
      channelType: 'private' as const,
      channelId: 'dm',
      messageId: 'message',
    }
    await service.remote(origin, { action: 'create', instruction: '第一项' }, 'step-1')
    await service.remote(origin, { action: 'create', instruction: '第二项' }, 'step-2')
    expect(tasks.dispatch.mock.calls[0]![0].idempotencyKey).not.toBe(
      tasks.dispatch.mock.calls[1]![0].idempotencyKey,
    )
  })
})
