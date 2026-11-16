import { afterEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createDrizzleConnection, closeDrizzleConnection } from '@infos/backend/database'
import { conversationExecutions, threads } from '@infos/backend/database/schema'
import { ExecutionRuntime, KernelOutboxRepository, KernelScheduler } from '@infos/backend/kernel'
import { ThreadRepository } from '@infos/backend/repositories/thread.repo'
import { ThreadService } from '@infos/backend/services/thread/threadService'
import { ConversationTurnService } from '@infos/backend/services/conversation/conversationTurnService'
import { ConversationProjectionService } from '@infos/backend/projections/conversationProjectionService'
import type { CompiledRunParams } from '@infos/backend/services/agent/agentService'

const connections: ReturnType<typeof createDrizzleConnection>[] = []
afterEach(() => {
  for (const db of connections.splice(0)) closeDrizzleConnection(db)
})

function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

async function fixture(maxRunning = 3, maxQueued = 8) {
  const db = createDrizzleConnection(':memory:')
  connections.push(db)
  const threadService = new ThreadService(new ThreadRepository(db))
  const main = await threadService.getMainThread('pero')
  const sideA = await threadService.createThread({ id: 'side-a', agentId: 'pero', channel: 'desktop' })
  const sideB = await threadService.createThread({ id: 'side-b', agentId: 'pero', channel: 'desktop' })
  const executionRuntime = new ExecutionRuntime(new KernelOutboxRepository(db))
  const scheduler = new KernelScheduler(executionRuntime, {
    maxRunning, maxQueued, classConcurrency: { interactive: 2, background: 1 }, agingIntervalMs: 100,
  })
  const onUserActivity = vi.fn().mockResolvedValue(undefined)
  const agent = {
    chatWithCompiledMessages: vi.fn(async (_input: CompiledRunParams) => '完成'),
    chatStreamWithCompiledMessages: vi.fn(async function* (_input: CompiledRunParams) {
      yield { event: 'narration_delta' as const, data: { delta: '流式结果' } }
    }),
  }
  const service = new ConversationTurnService({
    threadService, kernelScheduler: scheduler,
    executionRuntime,
    onUserActivity,
    contextCompiler: {
      characterStateRevision: vi.fn().mockResolvedValue(0),
      compile: vi.fn(async () => ({ messages: [{ role: 'user', content: '输入' }], manifest: { disabledTools: [] } })),
    },
    agentService: agent,
    attachmentService: { validateForBinding: vi.fn().mockResolvedValue([]), bindOutgoing: vi.fn() },
  } as never)
  return { db, service, scheduler, threadService, main, sideA, sideB, agent, onUserActivity }
}

describe('普通会话统一调度', () => {
  it.each(['stream', 'non_stream'] as const)('主线 %s 模型失败保留唯一输入及提交身份，重复请求不再落盘', async (mode) => {
    const { service, scheduler, threadService, main, agent } = await fixture(1)
    const error = new Error('HTTP_400_INVALID_TOOL_SCHEMA')
    agent.chatWithCompiledMessages.mockRejectedValue(error)
    agent.chatStreamWithCompiledMessages.mockImplementation(async function* () { throw error })
    const run = async () => {
      const params = { threadId: main.id, content: '你好呀', queueMessageId: 'submission' }
      if (mode === 'non_stream') return service.executeTurn(params)
      for await (const _chunk of service.streamTurn(params)) { /* 等待执行结算。 */ }
    }
    await expect(run()).rejects.toThrow('HTTP_400_INVALID_TOOL_SCHEMA')
    await expect(run()).rejects.toThrow()
    const messages = await threadService.getActiveMessages(main.id)
    expect(messages.map((message) => [message.role, message.content, message.pairId, message.publicationId]))
      .toEqual([['user', '你好呀', null, `conversation:${main.id}:1:submission:input`]])
    const projection = new ConversationProjectionService(threadService, { listForMessages: async () => new Map() } as never)
    const snapshot = await projection.getSnapshot(main.id)
    expect(snapshot.messages.map((message) => [message.role, message.messageId]))
      .toEqual([['user', String(messages[0]!.id)], ['assistant', `execution:conversation:${main.id}:1:submission`]])
    expect(snapshot.messages[1]!.failureMessage).toBe('HTTP_400_INVALID_TOOL_SCHEMA')
    expect(snapshot.messages[0]!.publicationId).toBe(`conversation:${main.id}:1:submission:input`)
    expect(scheduler.getDiagnostics()).toMatchObject({ running: 0, queued: 0 })
  })

  it('主侧会话共享全局及交互并发，排队输入在准入后保存', async () => {
    const { service, scheduler, threadService, main, sideA, sideB, agent, onUserActivity } = await fixture()
    const background = gate()
    const first = gate()
    const second = gate()
    const blocker = await scheduler.submit({ principalId: 'nana', class: 'background', run: () => background.promise })
    agent.chatWithCompiledMessages.mockImplementation(async (input) => {
      await (input.threadId === main.id ? first.promise : second.promise)
      return `完成 ${input.threadId}`
    })
    const mainTurn = service.executeTurn({ threadId: main.id, content: '主线工作' })
    const sideTurn = service.executeTurn({ threadId: sideA.id, content: '侧线工作' })
    await vi.waitFor(() => expect(agent.chatWithCompiledMessages).toHaveBeenCalledTimes(2))
    const streaming = service.streamTurn({ threadId: sideB.id, content: '另一个侧线' })
    const next = streaming.next()
    await vi.waitFor(() => expect(scheduler.getDiagnostics()).toMatchObject({ running: 3, queued: 1 }))
    expect(await threadService.getActiveMessages(sideB.id)).toEqual([])
    first.release()
    const mainResult = await mainTurn
    expect(mainResult.reply).toBe(`完成 ${main.id}`)
    expect((await next).value).toMatchObject({ event: 'narration_delta', data: { delta: '流式结果' } })
    const final = await streaming.next()
    expect(final.done).toBe(true)
    expect(final.value).toMatchObject({ reply: '流式结果', execution: { threadId: sideB.id } })
    second.release()
    background.release()
    await sideTurn
    await scheduler.waitForTerminal(blocker.descriptor.executionId)
    expect(onUserActivity.mock.calls.map(([agentId, threadId]) => [agentId, threadId]))
      .toEqual([['pero', main.id], ['pero', sideA.id], ['pero', sideB.id]])
    expect((await threadService.getActiveMessages(sideB.id)).map((message) => message.content))
      .toEqual(['另一个侧线', '流式结果'])
  })

  it('取消排队的流式会话只释放该请求，正在运行的任务继续', async () => {
    const { service, scheduler, threadService, sideA, agent } = await fixture(1)
    const background = gate()
    const blocker = await scheduler.submit({ principalId: 'nana', class: 'background', run: () => background.promise })
    const controller = new AbortController()
    const stream = service.streamTurn({ threadId: sideA.id, content: '排队输入', signal: controller.signal })
    const rejected = expect(stream.next()).rejects.toThrow('停止排队')
    await vi.waitFor(() => expect(scheduler.getDiagnostics().queued).toBe(1))
    controller.abort(new Error('停止排队'))
    await rejected
    expect(scheduler.get(blocker.descriptor.executionId)?.state).toBe('running')
    expect(agent.chatStreamWithCompiledMessages).not.toHaveBeenCalled()
    expect(await threadService.getActiveMessages(sideA.id)).toEqual([])
    expect(scheduler.getDiagnostics().queued).toBe(0)
    background.release()
    await scheduler.waitForTerminal(blocker.descriptor.executionId)
  })

  it('排队期间主线代次变化后拒绝旧输入，释放名额供后续会话使用', async () => {
    const { db, service, scheduler, threadService, main, sideA, agent } = await fixture(1)
    const background = gate()
    const blocker = await scheduler.submit({ principalId: 'nana', class: 'background', run: () => background.promise })
    const rejected = expect(service.executeTurn({ threadId: main.id, content: '旧代次输入' })).rejects.toThrow()
    await vi.waitFor(() => expect(scheduler.getDiagnostics().queued).toBe(1))
    db.update(threads).set({ generation: main.generation + 1 }).where(eq(threads.id, main.id)).run()
    background.release()
    await scheduler.waitForTerminal(blocker.descriptor.executionId)
    await rejected
    expect(await threadService.getActiveMessages(main.id)).toEqual([])
    expect(agent.chatWithCompiledMessages).not.toHaveBeenCalled()
    expect((await service.executeTurn({ threadId: sideA.id, content: '后续请求' })).reply).toBe('完成')
  })

  it('消费方提前关闭流后回收生成器及调度名额', async () => {
    const { service, scheduler, sideA, sideB, agent } = await fixture(1)
    let cleaned = false
    agent.chatStreamWithCompiledMessages.mockImplementation(async function* () {
      try {
        for (let index = 0; index < 10; index++)
          yield { event: 'narration_delta' as const, data: { delta: String(index) } }
      } finally {
        cleaned = true
      }
    })
    const stream = service.streamTurn({ threadId: sideA.id, content: '流式任务' })
    expect((await stream.next()).done).toBe(false)
    await stream.return(undefined as never)
    expect(cleaned).toBe(true)
    expect(scheduler.getDiagnostics()).toMatchObject({ running: 0, queued: 0 })
    expect((await service.executeTurn({ threadId: sideB.id, content: '后续请求' })).reply).toBe('完成')
  })

  it('已持有的执行身份直接继承，嵌套内部交互沿父级准入', async () => {
    const { service, scheduler, sideA, sideB } = await fixture(1)
    const observed = vi.fn()
    let inheritedId = ''
    let nestedParentId = ''
    const terminal = await scheduler.submitAndWait({ principalId: 'pero', class: 'background', run: async (execution) => {
      const inherited = await service.executeTurn({ threadId: sideA.id, content: '继承执行',
        execution: execution.descriptor, signal: execution.signal, onExecutionStarted: observed })
      inheritedId = inherited.execution!.executionId
      const nested = await service.executeTurn({ threadId: sideB.id, content: '内部临时交互',
        realmId: 'internal-app', inputPersistence: 'ephemeral', outputPersistence: 'ephemeral' })
      nestedParentId = nested.execution!.parentExecutionId!
    } })
    expect(terminal.state).toBe('completed')
    expect(inheritedId).toBe(terminal.descriptor.executionId)
    expect(nestedParentId).toBe(terminal.descriptor.executionId)
    expect(observed).toHaveBeenCalledWith(terminal.descriptor)
    expect(scheduler.list()).toHaveLength(1)
  })

  it('执行观察者失败后结算主线执行，并释放名额', async () => {
    const { db, service, scheduler, main } = await fixture(1)
    await expect(service.executeTurn({ threadId: main.id, content: '输入',
      onExecutionStarted: async () => { throw new Error('观察异常') } })).rejects.toThrow('观察异常')
    expect(db.select({ status: conversationExecutions.status }).from(conversationExecutions)
      .where(eq(conversationExecutions.threadId, main.id)).all()).toEqual([{ status: 'failed' }])
    expect(scheduler.getDiagnostics()).toMatchObject({ running: 0, queued: 0 })
    expect((await service.executeTurn({ threadId: main.id, content: '继续交流' })).reply).toBe('完成')
  })

  it('队列背压保留已有执行并拒绝额外输入，取消后可继续准入', async () => {
    const { service, scheduler, threadService, sideA, sideB } = await fixture(1, 1)
    const background = gate()
    const blocker = await scheduler.submit({ principalId: 'nana', class: 'background', run: () => background.promise })
    const controller = new AbortController()
    const rejected = expect(service.executeTurn({ threadId: sideA.id, content: '等待', signal: controller.signal }))
      .rejects.toThrow('取消等待')
    await vi.waitFor(() => expect(scheduler.getDiagnostics().queued).toBe(1))
    await expect(service.executeTurn({ threadId: sideB.id, content: '额外输入' }))
      .rejects.toMatchObject({ code: 'RESOURCE_BUSY' })
    expect(await threadService.getActiveMessages(sideB.id)).toEqual([])
    expect(scheduler.get(blocker.descriptor.executionId)?.state).toBe('running')
    controller.abort(new Error('取消等待'))
    await rejected
    background.release()
    await scheduler.waitForTerminal(blocker.descriptor.executionId)
    expect((await service.executeTurn({ threadId: sideB.id, content: '重新请求' })).reply).toBe('完成')
  })

  it('用量及 I/O 归入同一执行，并保留调用方的统计回调', async () => {
    const { service, scheduler, sideA, agent } = await fixture()
    const onUsage = vi.fn()
    const releaseIo = vi.fn()
    agent.chatWithCompiledMessages.mockImplementation(async (input) => {
      const finish = input.beginIo!()
      input.onUsage?.({ llmCalls: 1, inputTokens: 12, outputTokens: 5, toolCalls: 3 })
      finish()
      return '完成'
    })
    const result = await service.executeTurn({ threadId: sideA.id, content: '统计', onUsage, beginIo: () => releaseIo })
    expect(scheduler.get(result.execution!.executionId)).toMatchObject({
      state: 'completed', usage: { llmCalls: 1, inputTokens: 12, outputTokens: 5, toolCalls: 3, concurrentIo: 0 },
    })
    expect(onUsage).toHaveBeenCalledWith({ llmCalls: 1, inputTokens: 12, outputTokens: 5, toolCalls: 3 })
    expect(releaseIo).toHaveBeenCalledTimes(1)
  })
})
