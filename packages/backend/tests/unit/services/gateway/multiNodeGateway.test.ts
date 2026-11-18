import { describe, expect, it, vi } from 'vitest'
import { expandProjection, projectionBaseline, THREAD_SURFACE_SYNC } from '@infos/shared'
import type { ConversationMessageProjection, ConversationProjectionSnapshot, DeltaFrame, SurfaceFrame, SurfaceId } from '@infos/shared'
import type { KernelNodeDescriptor, KernelNodeId } from '@infos/shared'
import { NodeRegistry } from '../../../../src/kernel/nodeRegistry'
import { GatewayHub } from '../../../../src/services/gateway/gatewayHub'
import { DurableGatewayStream } from '../../../../src/services/gateway/durableGatewayStream'
import { createEnvelope } from '../../../../src/services/gateway/types'

const nodeId = 'client-stable-1' as KernelNodeId
const descriptor: KernelNodeDescriptor = {
  nodeId,
  displayName: '浏览器客户端',
  facets: ['client', 'device'],
  trust: 'local',
  platform: { os: 'web', runtime: 'browser' },
  protocolVersion: 1,
  registeredAt: '2026-08-28T00:00:00.000Z',
}

function message(type: 'hello' | 'request' | 'heartbeat', payload: Record<string, unknown>) {
  return JSON.stringify({
    protocolVersion: 1,
    id: crypto.randomUUID(),
    type,
    sourceId: nodeId,
    targetId: 'backend',
    timestamp: Date.now(),
    payload,
  })
}

describe('Gateway 多节点闭环', () => {
  it('按观察范围交付实时帧，旧连接收到完整历史，重新观察先交付全量', async () => {
    const hub = new GatewayHub(new NodeRegistry())
    const modern = vi.fn<(data: string) => void>()
    const legacy = vi.fn<(data: string) => void>()
    hub.registerNode('modern', modern)
    hub.registerNode('legacy', legacy)
    await hub.handleMessage(message('hello', { nodeId: 'new', features: [THREAD_SURFACE_SYNC] }), 'modern')
    await hub.handleMessage(message('hello', { nodeId: 'old' }), 'legacy')
    const watch = (watching: boolean) => hub.handleMessage(message('request', {
      action: 'gateway.watch_thread', threadId: 't', watching,
    }), 'modern')
    await watch(true)
    modern.mockClear()
    legacy.mockClear()
    const row = (messageId: string, content: string): ConversationMessageProjection => ({
      messageId, content, threadId: 't', role: 'assistant', revision: 1, imageTranscription: false,
      status: 'completed', timestamp: '2026-11-18T00:00:00Z', contentBlocks: [], toolCalls: [], attachments: [],
    })
    const page: ConversationProjectionSnapshot = {
      protocolVersion: 1, threadId: 't', threadGeneration: 1, principalId: 'pero', revision: 7, generatedAt: '2026-11-18',
      messages: [row('1', '移出窗口'), row('2', '未改动的正文'), row('3', '编辑前')],
      surfaces: [{ surfaceId: 'approval' as SurfaceId, generation: 'g', threadId: 't', principalId: 'pero',
        revision: 1, sequence: 1, state: 'open', nodes: [] }],
    }
    const initial: SurfaceFrame = {
      protocolVersion: 1, threadId: 't', generation: 'g', revision: 1, sequence: 1, surfaceId: 'live' as SurfaceId,
      operationId: 'first', operation: { type: 'surface.publish', snapshot: page },
    }
    const final: SurfaceFrame = { ...initial, operationId: 'second', sequence: 2, operation: {
      type: 'surface.settled', snapshot: { ...page, deletedMessageIds: ['99'], beforeCursor: '2',
        messages: [row('2', '未改动的正文'), row('3', '已编辑'), row('4', '新回复')],
        surfaces: [{ ...page.surfaces[0]!, state: 'committed' }] },
    } }
    await hub.pushSurface({ ...initial, threadId: 'elsewhere', operation: { type: 'surface.dispose' } })
    await hub.pushQueueChanged('elsewhere')
    expect(modern.mock.calls).toEqual([])
    expect(legacy.mock.calls).toHaveLength(1)
    await hub.pushSurface(initial)
    await hub.pushSurface(final)
    await hub.pushQueueChanged('t')
    const [full, compact, hint] = modern.mock.calls.map(([data]) => JSON.parse(data).payload)
    expect(full.frame).toEqual(initial)
    const delta: DeltaFrame = compact.delta
    expect(delta.operation.snapshot.messages[0]).toBe('2')
    expect(modern.mock.calls[1]![0]).not.toContain('未改动的正文')
    expect(expandProjection(delta, projectionBaseline(full.frame))).toEqual(final)
    const missing = { ...delta, operation: { ...delta.operation,
      snapshot: { ...delta.operation.snapshot, messages: ['unknown-id'] } } }
    expect(() => expandProjection(missing, projectionBaseline(full.frame))).toThrow('SURFACE_DELTA_REFERENCE_INVALID')
    expect(hint).toEqual({ action: 'conversation_queue_changed', threadId: 't' })
    expect(legacy.mock.calls.map(([data]) => JSON.parse(data).payload.frame.operationId)).toEqual(['first', 'first', 'second'])

    const commit: SurfaceFrame = { ...initial, operationId: 'commit', operation: {
      type: 'surface.commit', snapshot: page, message: page.messages[0]!, surface: page.surfaces[0]!,
    } }
    await hub.pushSurface(commit)
    expect(expandProjection(JSON.parse(modern.mock.lastCall![0]).payload.delta, projectionBaseline(final))).toEqual(commit)

    const reset: SurfaceFrame = { ...initial, operationId: 'reset',
      operation: { type: 'surface.publish', snapshot: { ...page, threadGeneration: 2 } } }
    await hub.pushSurface(reset)
    expect(JSON.parse(modern.mock.lastCall![0]).payload.frame).toEqual(reset)
    await watch(false)
    modern.mockClear()
    await hub.pushSurface(final)
    expect(modern.mock.calls).toEqual([])
    await watch(true)
    await hub.pushSurface(final)
    expect(JSON.parse(modern.mock.lastCall![0]).payload.frame).toEqual(final)
  })
  it('切换当前角色后，只接收该角色的回复就绪提示且无需重建连接', async () => {
    const registry = new NodeRegistry()
    const send = vi.fn()
    const hub = new GatewayHub(registry)
    hub.registerNode('connection-1', send)
    await hub.handleMessage(message('hello', { nodeId, principalId: 'pero' }), 'connection-1')
    const session = registry.getActiveSession(nodeId)
    await hub.handleMessage(
      message('request', { action: 'gateway.select_principal', principalId: 'nana' }),
      'connection-1',
    )
    send.mockClear()
    await hub.pushBusiness(
      'conversation_reply_ready',
      { messageId: '1' },
      { type: 'all_principal_clients', principalId: 'pero' },
    )
    expect(send).not.toHaveBeenCalled()
    await hub.pushBusiness(
      'conversation_reply_ready',
      { messageId: '2' },
      { type: 'all_principal_clients', principalId: 'nana' },
    )
    expect(send).toHaveBeenCalledOnce()
    expect(registry.getActiveSession(nodeId)?.sessionId).toBe(session?.sessionId)
  })
  it('稳定 Node 重连时应保留 Node ID 并递增 Session Generation', async () => {
    const registry = new NodeRegistry()
    const firstSend = vi.fn()
    const secondSend = vi.fn()
    const hub = new GatewayHub(registry)
    hub.registerNode('connection-1', firstSend)
    await hub.handleMessage(
      message('hello', { nodeId, principalId: 'pero', deviceName: descriptor.displayName }),
      'connection-1',
    )
    const first = registry.getActiveSession(nodeId)!
    hub.unregisterNode('connection-1')

    hub.registerNode('connection-2', secondSend)
    await hub.handleMessage(
      message('hello', { nodeId, principalId: 'pero', deviceName: descriptor.displayName }),
      'connection-2',
    )
    const second = registry.getActiveSession(nodeId)!

    expect(first.generation).toBe(1)
    expect(second.generation).toBe(2)
    expect(second.connectionId).toBe('connection-2')
    expect(JSON.parse(secondSend.mock.calls[0]![0])).toMatchObject({
      type: 'hello_ack',
      payload: { nodeId, generation: 2 },
    })
  })

  it('Input Seat 应绑定当前 Session 且旧 Session 断开后失效', async () => {
    const registry = new NodeRegistry()
    const send = vi.fn()
    const hub = new GatewayHub(registry)
    hub.registerNode('connection-1', send)
    await hub.handleMessage(message('hello', { nodeId, principalId: 'pero' }), 'connection-1')
    await hub.handleMessage(
      message('request', {
        action: 'input_seat.acquire',
        principalId: 'pero',
        windowId: 'main',
      }),
      'connection-1',
    )

    const seat = registry.getInputSeat('pero', 'approval')
    expect(seat?.nodeId).toBe(nodeId)
    hub.unregisterNode('connection-1')
    expect(registry.getInputSeat('pero')).toBeNull()
  })

  it('Audience 应只把审批投递给 active Input Seat', async () => {
    const registry = new NodeRegistry()
    const sendA = vi.fn()
    const sendB = vi.fn()
    const hub = new GatewayHub(registry)
    for (const [connection, stableNode, send] of [
      ['connection-a', 'client-a', sendA],
      ['connection-b', 'client-b', sendB],
    ] as const) {
      hub.registerNode(connection, send)
      await hub.handleMessage(
        message('hello', { nodeId: stableNode, principalId: 'pero' }),
        connection,
      )
    }
    await hub.handleMessage(
      message('request', { action: 'input_seat.acquire', principalId: 'pero' }),
      'connection-b',
    )
    sendA.mockClear()
    sendB.mockClear()

    await hub.pushBusiness(
      'tool_approval_requested',
      { request: { id: 'approval-1' } },
      { type: 'active_input_seat', principalId: 'pero' },
      'approval:pero',
    )

    expect(sendA).not.toHaveBeenCalled()
    expect(sendB).toHaveBeenCalledOnce()
  })

  it('Durable Stream 应支持 Cursor 补发和 Snapshot Fallback', () => {
    const stream = new DurableGatewayStream(2)
    for (let index = 0; index < 3; index += 1) {
      stream.append('thread:main', createEnvelope('push', { action: 'proactive_message', index }))
    }
    expect(stream.read('thread:main', 1)).toMatchObject({
      retentionFloor: 2,
      latestSequence: 3,
      snapshotRequired: false,
    })
    expect(stream.read('thread:main', 0).events.map((event) => event.sequence)).toEqual([2, 3])
    const snapshotStream = new DurableGatewayStream(1)
    for (let index = 0; index < 3; index += 1) {
      snapshotStream.append(
        'thread:snapshot',
        createEnvelope('push', { action: 'proactive_message', index }),
      )
    }
    expect(snapshotStream.read('thread:snapshot', 1).snapshotRequired).toBe(true)
  })
})
