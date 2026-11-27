import { ipcRenderer } from 'electron'
import type { DesktopApprovalView } from '../main/services/desktopGuardModel'

// 审批页没有通用 IPC。所有外部内容只填入文本节点，选择只能来自此窗口的真实交互。
window.addEventListener('DOMContentLoaded', async () => {
  const view: DesktopApprovalView = await ipcRenderer.invoke('desktop-approval:read')
  document.title = view.title
  const element = (id: string) => document.getElementById(id)!
  element('title').textContent = view.title
  element('heading').textContent = view.heading
  if (view.badge) {
    const badge = element('badge')
    badge.hidden = false
    badge.textContent = view.badge
    badge.classList.toggle('warning', !!view.warning)
  }
  for (const line of view.detail.split('\n').filter(Boolean)) {
    const row = document.createElement('p')
    row.textContent = line
    element('detail').append(row)
  }
  for (const { answer, label } of view.choices) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = label
    button.dataset.answer = answer
    button.addEventListener('click', (event) => {
      if (event.isTrusted) ipcRenderer.send('desktop-approval:answer', answer)
    })
    const group = element(answer === 'thread' || answer === 'trust' ? 'extended' : 'actions')
    group.hidden = false
    group.append(button)
    if (answer === 'deny') button.focus()
  }
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && event.isTrusted) ipcRenderer.send('desktop-approval:answer', 'deny')
  })
  ipcRenderer.send('desktop-approval:ready', document.body.scrollHeight)
  document.body.classList.add('ready')
})
