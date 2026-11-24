import { reactive } from 'vue'
import type { BrowserObserverSession } from '@infos/shared'
import { getWebServerOrigin } from '../../api/transport'

export type ObserverDisplay = 'expanded' | 'collapsed' | 'closed'

const storageKey = 'infos.browserObserver.visibility'
const limit = 128

function readChoices(): Map<string, boolean> {
  try {
    const entries: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? '[]')
    if (Array.isArray(entries)) {
      const valid = entries.filter(
        (entry): entry is [string, boolean] =>
          Array.isArray(entry) &&
          entry.length === 2 &&
          typeof entry[0] === 'string' &&
          typeof entry[1] === 'boolean',
      )
      return new Map(valid.slice(-limit))
    }
  } catch {
    /* 存储不可用时只保留当前窗口的选择。 */
  }
  return new Map()
}

// 对话、工作区和任务详情共用当前窗口的选择。四项键兼容旧版保存的展开与收起状态。
const choices = reactive(readChoices())
const threadKey = (agentId: string, threadId: string) =>
  JSON.stringify([getWebServerOrigin(), agentId, threadId])
const sessionKey = (session: BrowserObserverSession) =>
  JSON.stringify([getWebServerOrigin(), session.agentId, session.threadId, session.taskId ?? null])

export function observerDisplay(
  agentId: string,
  threadId: string,
  session: BrowserObserverSession,
): ObserverDisplay {
  if (choices.get(threadKey(agentId, threadId)) === false) return 'closed'
  const expanded = choices.get(sessionKey(session)) ?? session.requestedVisible
  return expanded ? 'expanded' : 'collapsed'
}

export function setObserverDisplay(
  agentId: string,
  threadId: string,
  session: BrowserObserverSession,
  display: ObserverDisplay,
): void {
  // 关闭针对正在观看的对话。后台任务换页或换为最新会话时，整个浮窗仍保持关闭。
  const scope = threadKey(agentId, threadId)
  choices.delete(scope)
  if (display === 'closed') {
    choices.set(scope, false)
  } else {
    const key = sessionKey(session)
    choices.delete(key)
    choices.set(key, display === 'expanded')
  }
  while (choices.size > limit) choices.delete(choices.keys().next().value!)
  try {
    sessionStorage.setItem(storageKey, JSON.stringify([...choices]))
  } catch {
    /* 存储不可用时同一窗口内仍同步生效。 */
  }
}
