/** 仅显示文本，不执行错误内容；脚本异常与未处理的 Promise 都有可见说明。 */
export interface CardDiagnosticLabels {
  error: string
  dismiss: string
  retry: string
  unbound: string
  failed: string
}
let labels: CardDiagnosticLabels | undefined
let pending = ''
let render: (() => void) | undefined

export function showCardError(reason: unknown): void {
  const message = reason instanceof Error ? reason.message : String(reason)
  pending = message.includes('HOME_CARD_UNBOUND') ? 'HOME_CARD_UNBOUND' : message.slice(0, 1200)
  render?.()
}

window.addEventListener('error', (event) => showCardError(event.message || 'HOME_CARD_ERROR'))
window.addEventListener('unhandledrejection', (event) => showCardError(event.reason))

export function installCardDiagnostics(
  shell: HTMLElement,
  retry: () => void,
): (value: CardDiagnosticLabels) => void {
  const panel = document.createElement('section')
  panel.setAttribute('role', 'alert')
  panel.className = 'card-diagnostic'
  const heading = document.createElement('strong'),
    detail = document.createElement('pre')
  const reload = document.createElement('button'),
    dismiss = document.createElement('button')
  const actions = document.createElement('div')
  actions.className = 'card-diagnostic__actions'
  actions.append(reload, dismiss)
  reload.addEventListener('click', (event) => {
    if (event.isTrusted) retry()
  })
  dismiss.addEventListener('click', () => {
    pending = ''
    panel.hidden = true
  })
  panel.append(heading, detail, actions)
  shell.append(panel)
  render = () => {
    panel.hidden = !pending || !labels
    if (!labels) return
    heading.textContent = labels.error
    detail.textContent =
      pending === 'HOME_CARD_UNBOUND'
        ? labels.unbound
        : /HOME_|DESKTOP_CARD_/.test(pending)
          ? labels.failed
          : pending
    reload.textContent = labels.retry
    dismiss.textContent = labels.dismiss
  }
  render()
  return (value) => {
    labels = value
    render?.()
  }
}
