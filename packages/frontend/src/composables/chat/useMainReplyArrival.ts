import { nextTick, watch, type Ref } from 'vue'
import type { ChatMessage } from '../../stores/useThreadStore'

function pendingReply(rows: ChatMessage[]) {
  return rows.find(row => row.role === 'assistant' && (row.isStreaming || row.executionPending))
}

/** 入场只跟随当前主会话的交付，虚拟列表挂载历史行时不触发。 */
export function useMainReplyArrival(
  container: Ref<HTMLElement | null>,
  scope: () => string | undefined,
  timeline: Readonly<Ref<ChatMessage[]>>,
) {
  let waitingId = scope() ? pendingReply(timeline.value)?.id : undefined
  watch([scope, timeline], async ([owner, rows], [lastOwner, previous]) => {
    const priorWait = owner === lastOwner ? waitingId : undefined
    const waiting = owner ? pendingReply(rows) : undefined
    // 队列补读终态时，可能先结束流式标记，再用快照替换同一个临时占位。
    waitingId = waiting?.id ?? (priorWait && rows.some(row => row.id === priorWait) ? priorWait : undefined)
    if (!owner || !priorWait || waiting?.id === priorWait) return

    const seen = new Set(previous.map(row => row.id))
    const firstSavedId = Number(previous.find(row => /^\d+$/.test(row.id))?.id ?? 0)
    const arrivals = new Set(rows
      .filter(row => row.role === 'assistant' && !row.executionRecord && !row.executionPending &&
        !seen.has(row.id) && Number(row.id) >= firstSavedId)
      .map(row => row.id))
    if (!arrivals.size) return

    await nextTick()
    if (scope() !== owner || !container.value?.isConnected || document.hidden) return
    for (const row of container.value.querySelectorAll<HTMLElement>('.msg-row-assistant[data-message-id]')) {
      if (row.dataset.messageId && arrivals.has(row.dataset.messageId)) {
        row.querySelector('.msg-bubble-assistant')?.classList.add('motion-main-reply-arrive')
      }
    }
  })
}
