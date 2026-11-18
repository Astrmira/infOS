// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { defineComponent } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import type { ConversationProjectionSnapshot, SurfaceFrame, SurfaceId } from '@infos/shared'
import { useThreadStore } from '@infos/frontend/stores/useThreadStore'
import { useConversationQueue } from '@infos/frontend/composables/chat/useConversationQueue'
import type { GatewayEvents } from '@infos/frontend/composables/gateway/useGateway'

const api = vi.hoisted(() => ({
  gateway: vi.fn<(events: GatewayEvents) => void>(),
  queue: vi.fn(), projection: vi.fn(), getThread: vi.fn(),
}))
vi.mock('@infos/frontend/composables/gateway/useGateway', () => ({
  useGateway: (events: GatewayEvents) => {
    api.gateway(events)
    return { watchThread: () => () => {}, isWatchingThread: () => false }
  },
}))
vi.mock('@infos/frontend/api/modules/chatApi', () => ({ chatApi: { queue: api.queue } }))
vi.mock('@infos/frontend/api/modules/threadsApi', () => ({
  threadsApi: { get: api.getThread, getProjection: api.projection },
}))
vi.mock('@infos/frontend/api/transport', async (original) => ({
  ...await original<typeof import('@infos/frontend/api/transport')>(),
  isLocalBackendRuntime: () => false,
}))

describe('队列结算与持久历史同步', () => {
  it.each([
    ['terminal', false, 1, '终态中的回复', 0],
    ['terminal', false, 2, '终态中的回复', 0],
    ['another-run', false, 1, '重新读取的回复', 1],
    [undefined, false, 1, '重新读取的回复', 1],
    ['terminal', true, 1, '重新读取的回复', 1],
  ] as const)('服务端确认 %s、暂停 %s、%i 个订阅者时保留正确的消息和游标', async (terminalId, paused, observers, expected, reads) => {
    vi.resetAllMocks()
    const pinia = createPinia()
    setActivePinia(pinia)
    const thread = useThreadStore()
    thread.startThread('thread', 'desktop', 'pero')
    thread.threadKind = 'main'
    const projection: ConversationProjectionSnapshot = {
      protocolVersion: 1, threadId: 'thread', threadGeneration: 1, principalId: 'pero',
      revision: 2, generatedAt: '2026-11-18T00:00:00Z',
      messages: [{ messageId: '42', threadId: 'thread', role: 'assistant', content: '终态中的回复',
        timestamp: '2026-11-18T00:00:00Z', revision: 1, imageTranscription: false,
        status: 'completed', toolCalls: [], contentBlocks: [], attachments: [] }],
      surfaces: [], totalMessages: 3, hasMoreBefore: true, beforeCursor: '41',
    }
    const reply = projection.messages[0]!
    const userInput = { ...reply, role: 'user' as const, messageId: '41', content: '请继续', publicationId: 'conversation:thread:1:queue-1:input' }
    projection.messages = [userInput, reply]
    const idle = { threadId: 'thread', active: false, paused, items: [], terminalOperationId: terminalId }
    api.queue.mockResolvedValue({ data: idle })
    api.projection.mockResolvedValue({ data: { ...projection,
      messages: [userInput, { ...reply, revision: 2, content: '重新读取的回复' }] } })
    api.getThread.mockResolvedValue({ data: { thread: {
      id: 'thread', agentId: 'pero', generation: 1, threadKind: 'main', channel: 'desktop',
      interactionMode: 'chat', executionMode: 'manual',
    } } })
    const wrapper = mount(defineComponent({
      setup() {
        for (let i = 0; i < observers; i++) useConversationQueue()
        return () => null
      },
    }), { global: { plugins: [pinia] } })
    try {
      await flushPromises()
      const deliver = (event: SurfaceFrame) => {
        for (const [subscriber] of api.gateway.mock.calls) subscriber.onSurface!(event)
      }
      const frame = { protocolVersion: 1, threadId: 'thread', threadGeneration: 1,
        surfaceId: 'live' as SurfaceId, generation: 'run' } as const
      let resolveEarlier!: (response: unknown) => void
      api.queue.mockImplementationOnce(() => new Promise(resolve => { resolveEarlier = resolve }))
      const pending = thread.beginPendingTurn('请继续', [], 'queue-1')
      deliver({ ...frame, revision: 1, sequence: 1, operationId: 'open',
        operation: { type: 'surface.open', threadId: 'thread', principalId: 'pero' } })
      expect(thread.messages.filter(message => message.role === 'assistant').map(message => message.id)).toEqual([pending.assistantId])
      deliver({ ...frame, revision: 2, sequence: 2, operationId: 'published',
        operation: { type: 'surface.publish', snapshot: { ...projection, messages: [
          userInput, { ...reply, executionPending: true },
        ] } } })
      expect(thread.timelineMessages.map(message => [message.id, message.content]))
        .toEqual([['41', '请继续'], [pending.assistantId, '']])
      deliver({ ...frame, revision: 3, sequence: 3, operationId: 'terminal',
        operation: { type: 'surface.settled', snapshot: projection } })
      resolveEarlier({ data: { ...idle, active: true, items: [{ id: 'old', state: 'running' }] } })
      await flushPromises()
      expect(thread.messages.map(message => message.content)).toEqual(['请继续', expected])
      expect(thread.isGenerating).toBe(false)
      expect(api.projection).toHaveBeenCalledTimes(reads)
      expect(thread.hasMoreHistory).toBe(true)
      api.projection.mockResolvedValueOnce({ data: { ...projection, beforeCursor: '40', hasMoreBefore: false,
        messages: [{ ...projection.messages[0], messageId: '40', content: '更早的消息' }] } })
      await thread.loadOlderMessages()
      expect(api.projection).toHaveBeenLastCalledWith('thread', { beforeCursor: '41', pageSize: 60 })
      expect(thread.messages.map(message => message.content)).toEqual(['更早的消息', '请继续', expected])
    } finally {
      wrapper.unmount()
      disposePinia(pinia)
    }
  })
})
