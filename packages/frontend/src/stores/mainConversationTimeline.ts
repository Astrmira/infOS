import type { ChatMessage } from './useThreadStore'
import type { ConversationQueueSnapshot } from '@infos/shared'

function speakerGroup(message: ChatMessage): string | undefined {
  if (message.isStreaming || message.executionPending || message.executionRecord ||
      (message.role !== 'user' && message.role !== 'assistant')) return
  const publication = message.publicationId
  const execution = message.timelineGroupId ?? message.executionId ?? (message.role === 'user' && publication?.endsWith(':input')
    ? publication.slice(0, -':input'.length) : undefined)
  if (execution) return `${execution}/${message.role}`
}

/** 同一次执行中，后发气泡紧随同一发言者，分页和消息操作仍使用原始身份。 */
export function mainConversationTimeline(messages: ChatMessage[], queue: ConversationQueueSnapshot | undefined, generation: number): ChatMessage[] {
  const groups = new Map<string, ChatMessage[]>()
  const slots: ChatMessage[][] = []
  let waiting: ChatMessage | undefined
  let pending: ChatMessage | undefined
  const submitted = queue?.items.length ? new Set(messages.map(m => m.publicationId ?? m.localPending?.queueId)) : undefined
  const previews: ChatMessage[] = []
  for (const item of queue?.items ?? []) {
    const input = item.input
    if (!input.supplementTo || input.expectedGeneration !== generation || input.taskResultEvent || item.immediate) continue
    const publicationId = `conversation:${input.threadId}:${input.expectedGeneration}:${item.id}:input`
    if (submitted?.has(publicationId) || submitted?.has(item.id)) continue
    previews.push({ id: `supplement:${item.id}`, role: 'user', content: input.content, publicationId,
      executionId: input.supplementTo, queuePreview: true, timestamp: new Date(item.createdAt).toISOString() })
  }
  for (const message of previews.length ? messages.concat(previews) : messages) {
    if (message.isStreaming) { waiting = message; continue }
    if (message.executionPending) { pending ??= message; continue }
    const group = speakerGroup(message)
    const siblings = group && groups.get(group)
    if (siblings) siblings.push(message)
    else {
      const slot = [message]
      slots.push(slot)
      if (group) groups.set(group, slot)
    }
  }
  const visible = slots.flat()
  if (waiting) visible.push(waiting)
  else if (pending) visible.push({
    id: `waiting:${pending.executionId ?? pending.id}`, role: 'assistant', content: '',
    timestamp: pending.timestamp, senderId: pending.senderId, executionPending: true,
  })
  return visible
}

export function continuesSpeaker(message: ChatMessage, previous?: ChatMessage): boolean {
  const group = speakerGroup(message)
  return !!group && !!previous && group === speakerGroup(previous)
}
