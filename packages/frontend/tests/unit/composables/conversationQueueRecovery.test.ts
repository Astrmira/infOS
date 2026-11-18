// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, reactive } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { ApiError } from '@infos/frontend/api/errors'
import { useConversationQueue } from '@infos/frontend/composables/chat/useConversationQueue'
import type { GatewayEvents } from '@infos/frontend/composables/gateway/useGateway'

const api = vi.hoisted(() => ({ queue: vi.fn(), session: vi.fn(), enqueue: vi.fn() }))
const live = vi.hoisted(() => ({ subscribed: false, events: {} as GatewayEvents }))
const history = vi.hoisted(() => ({
  threadId: 'thread', agentId: 'pero', messages: [],
  navigationTarget: null as { agentId: string; threadId?: string } | null,
  isGenerating: false, isLoadingHistory: false,
  hasAppliedTerminal: () => false,
  loadThreadMessages: vi.fn(), finishStreaming: vi.fn(),
  forgetThread: vi.fn(), clearThread: vi.fn(), loadLatestThread: vi.fn(),
  beginPendingTurn: vi.fn(() => ({ userId: 'pending-user', assistantId: 'pending-assistant' })),
  cancelPendingTurn: vi.fn(), renderKey: (id: string) => id,
}))
const diagnostics = vi.hoisted(() => ({ warn: vi.fn() }))
vi.mock('@infos/frontend/api/modules/chatApi', () => ({
  chatApi: { queue: api.queue, enqueue: api.enqueue },
}))
vi.mock('@infos/frontend/api/modules/clientAccessApi', () => ({
  clientAccessApi: { session: api.session },
}))
vi.mock('@infos/frontend/api/transport', () => ({
  getClientToken: () => 'credential',
  isLocalBackendRuntime: () => true,
}))
vi.mock('@infos/frontend/composables/gateway/useGateway', () => ({
  useGateway: (events: GatewayEvents) => {
    live.events = events
    return { watchThread: () => () => {}, isWatchingThread: () => live.subscribed }
  },
}))
vi.mock('@infos/frontend/lib/logger', () => ({ logger: diagnostics }))
vi.mock('@infos/frontend/stores', () => ({
  useThreadStore: () => reactive(history),
  useNotificationStore: () => ({ toast: vi.fn() }),
  useCompositorStore: () => ({}),
}))

beforeEach(() => {
  live.subscribed = false
  const threads = reactive(history)
  threads.threadId = 'thread'
  threads.agentId = 'pero'
  threads.navigationTarget = null
  api.queue.mockReset()
  api.session.mockReset()
  api.enqueue.mockReset()
  history.loadThreadMessages.mockResolvedValue({ status: 'loaded', threadId: 'thread' })
  history.clearThread.mockImplementation(() => { threads.threadId = '' })
  history.loadLatestThread.mockResolvedValue({ status: 'loaded', threadId: 'replacement' })
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('消息队列反馈与鉴权恢复', () => {
  it('其他设备完成整轮后补回错过的历史，同一终态只恢复一次', async () => {
    vi.useFakeTimers()
    live.subscribed = true
    const idle = { threadId: 'thread', active: false, paused: false, items: [] }
    api.queue.mockResolvedValue({ data: idle })
    const wrapper = mount(defineComponent({ setup() { useConversationQueue(); return () => null } }))
    try {
      await flushPromises()
      expect(history.loadThreadMessages).not.toHaveBeenCalled()
      api.queue.mockResolvedValue({ data: { ...idle, terminalOperationId: 'remote-run' } })
      live.events.onQueueChanged!('thread')
      await vi.advanceTimersByTimeAsync(100)
      expect(history.loadThreadMessages).toHaveBeenCalledWith('thread', 'pero', expect.any(AbortSignal))
      live.events.onQueueChanged!('thread')
      await vi.advanceTimersByTimeAsync(100)
      expect(history.loadThreadMessages).toHaveBeenCalledTimes(1)
    } finally {
      wrapper.unmount()
    }
  })
  it('空闲订阅退避，变更通知唤醒读取，在途期间收到的下一次变更仍会同步', async () => {
    vi.useFakeTimers()
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    live.subscribed = true
    const idle = { threadId: 'thread', paused: false, items: [] }
    api.queue.mockResolvedValue({ data: idle })
    let queue!: ReturnType<typeof useConversationQueue>
    const wrapper = mount(defineComponent({ setup() { queue = useConversationQueue(); return () => null } }))
    try {
      await flushPromises()
      await vi.advanceTimersByTimeAsync(2_000)
      expect(api.queue).toHaveBeenCalledTimes(1)
      let finish!: () => void
      api.queue.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ data: idle }) }))
      live.events.onQueueChanged!('thread')
      await vi.advanceTimersByTimeAsync(100)
      live.events.onQueueChanged!('thread')
      live.events.onQueueChanged!('thread')
      api.queue.mockResolvedValueOnce({ data: { ...idle, paused: true } })
      finish()
      await flushPromises()
      await vi.advanceTimersByTimeAsync(100)
      expect(api.queue).toHaveBeenCalledTimes(3)
      expect(queue.snapshot.value.paused).toBe(true)
    } finally {
      wrapper.unmount()
    }
  })
  it('目标会话不存在后终止原队列读取，清理选择并恢复有效会话', async () => {
    vi.useFakeTimers()
    api.queue.mockRejectedValue(new ApiError('NOT_FOUND', '目标对话不存在'))
    let queue!: ReturnType<typeof useConversationQueue>
    const wrapper = mount(defineComponent({
      setup() {
        queue = useConversationQueue()
        return () => null
      },
    }))
    try {
      await flushPromises()
      await vi.advanceTimersByTimeAsync(4_000)

      expect(api.queue).toHaveBeenCalledTimes(1)
      expect(history.forgetThread).toHaveBeenCalledWith('thread', 'pero')
      expect(history.clearThread).toHaveBeenCalledOnce()
      expect(history.loadLatestThread).toHaveBeenCalledWith('pero')
      expect(queue.snapshot.value).toEqual({ threadId: '', paused: false, items: [] })
      expect(diagnostics.warn).not.toHaveBeenCalled()
    } finally {
      wrapper.unmount()
    }
  })

  it.each(['response', 'not-found'] as const)(
    '切换会话取消旧请求，迟到的 %s 保留新队列状态', async (outcome) => {
      vi.useFakeTimers()
      let finishOld!: () => void
      const oldRequest = new Promise((resolve, reject) => {
        finishOld = () => outcome === 'not-found'
          ? reject(new ApiError('NOT_FOUND', '旧会话已删除'))
          : resolve({ data: { threadId: 'thread', paused: true, items: [] } })
      })
      api.queue.mockImplementation((threadId: string) => threadId === 'thread'
        ? oldRequest
        : Promise.resolve({ data: { threadId, paused: false, items: [] } }))
      let queue!: ReturnType<typeof useConversationQueue>
      const wrapper = mount(defineComponent({
        setup() {
          queue = useConversationQueue()
          return () => null
        },
      }))
      try {
        await flushPromises()
        const oldSignal = api.queue.mock.calls[0]![1] as AbortSignal
        reactive(history).threadId = 'next-thread'
        await flushPromises()

        expect(oldSignal.aborted).toBe(true)
        expect(queue.snapshot.value.threadId).toBe('next-thread')
        await vi.advanceTimersByTimeAsync(2_000)
        expect(api.queue.mock.calls.map(([threadId]) => threadId))
          .toEqual(['thread', 'next-thread', 'next-thread'])
        finishOld()
        await flushPromises()

        expect(queue.snapshot.value).toEqual({ threadId: 'next-thread', paused: false, items: [] })
        expect(queue.unavailable.value).toBe(false)
        expect(history.clearThread).not.toHaveBeenCalled()
        expect(diagnostics.warn).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(2_000)
        expect(api.queue.mock.calls.map(([threadId]) => threadId))
          .toEqual(['thread', 'next-thread', 'next-thread', 'next-thread'])
      } finally {
        finishOld()
        wrapper.unmount()
      }
    },
  )

  it('释放订阅时取消读取，迟到失败按已失效请求处理', async () => {
    vi.useFakeTimers()
    let rejectOld!: (error: Error) => void
    api.queue.mockReturnValue(new Promise((_resolve, reject) => { rejectOld = reject }))
    const wrapper = mount(defineComponent({
      setup() {
        useConversationQueue()
        return () => null
      },
    }))
    await flushPromises()
    const signal = api.queue.mock.calls[0]![1] as AbortSignal
    wrapper.unmount()
    expect(signal.aborted).toBe(true)
    rejectOld(new Error('迟到的连接错误'))
    await flushPromises()
    await vi.advanceTimersByTimeAsync(4_000)
    expect(api.queue).toHaveBeenCalledTimes(1)
    expect(diagnostics.warn).not.toHaveBeenCalled()
  })

  it('用户正在加载另一会话时，旧队列结果交给原订阅结算', async () => {
    vi.useFakeTimers()
    let resolveOld!: (value: unknown) => void
    api.queue.mockReturnValue(new Promise((resolve) => { resolveOld = resolve }))
    const wrapper = mount(defineComponent({
      setup() {
        useConversationQueue()
        return () => null
      },
    }))
    try {
      await flushPromises()
      const threads = reactive(history)
      threads.navigationTarget = { agentId: 'pero', threadId: 'next-thread' }
      resolveOld({ data: {
        threadId: 'thread', paused: false,
        items: [{
          id: 'old-run', state: 'running', revision: 1, position: 1, immediate: false,
          createdAt: 1, input: { threadId: 'thread', content: '执行中' },
        }],
      } })
      await flushPromises()
      await vi.advanceTimersByTimeAsync(2_000)

      expect(history.loadThreadMessages).not.toHaveBeenCalled()
      expect(api.queue).toHaveBeenCalledTimes(1)
      expect(threads.navigationTarget).toEqual({ agentId: 'pero', threadId: 'next-thread' })
    } finally {
      wrapper.unmount()
    }
  })

  it('入队后立即失败且未收到实时帧，也读取已保存的原文与错误', async () => {
    vi.useFakeTimers()
    api.queue.mockResolvedValue({
      data: { threadId: 'thread', active: false, paused: true, items: [] },
    })
    api.enqueue.mockResolvedValue({
      data: { threadId: 'thread', active: false, paused: true, items: [] },
    })
    let queue!: ReturnType<typeof useConversationQueue>
    const wrapper = mount(
      defineComponent({
        setup() {
          queue = useConversationQueue()
          return () => null
        },
      }),
    )
    try {
      await flushPromises()
      expect(history.loadThreadMessages).not.toHaveBeenCalled()
      await expect(
        queue.enqueue({ threadId: 'thread', agentId: 'pero', content: '请保存原文' }),
      ).resolves.toBe(true)
      await flushPromises()
      expect(history.loadThreadMessages).toHaveBeenCalledWith('thread', 'pero',
        expect.objectContaining({ aborted: false }))
      expect(history.finishStreaming).toHaveBeenCalled()
    } finally {
      wrapper.unmount()
    }
  })

  it('401 后停止业务轮询，只在公开状态确认恢复后继续读取队列', async () => {
    vi.useFakeTimers()
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    api.queue.mockResolvedValue({
      data: { threadId: 'thread', active: false, paused: false, items: [] },
    })
    api.queue.mockRejectedValueOnce(new ApiError('UNAUTHORIZED', '未授权'))
    api.session.mockResolvedValue({ data: { authenticated: false } })
    let queue: ReturnType<typeof useConversationQueue> | undefined
    const wrapper = mount(
      defineComponent({
        setup() {
          queue = useConversationQueue()
          return () => null
        },
      }),
    )
    try {
      await flushPromises()
      await vi.advanceTimersByTimeAsync(4000)
      expect(api.queue).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(2000)
      expect(api.session).toHaveBeenCalledTimes(1)
      expect(api.queue).toHaveBeenCalledTimes(1)
      api.session.mockResolvedValue({ data: { authenticated: true } })
      await vi.advanceTimersByTimeAsync(6000)
      expect(api.queue).toHaveBeenCalledTimes(2)
      expect(queue?.unavailable.value).toBe(false)
    } finally {
      wrapper.unmount()
    }
  })
})
