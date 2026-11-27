import { BrowserWindow, nativeTheme, screen } from 'electron'
import path from 'node:path'
import tokens from '../../../packages/frontend/src/assets/ui-tokens.css?raw'
import brandMark from '../../../public/infos-mark.svg?raw'
import style from './desktopApproval.css?raw'
import { getLocale, t } from '../utils/i18n'
import type { DesktopNormalMode, DesktopSafetyLoosening } from '../../../packages/shared/src/desktopSafety'
import type { DesktopApprovalView, GuardAnswer, GuardPrompt } from './desktopGuardModel'

const ui = (key: string, args?: unknown[]) => t('electron.ui.desktopGuard', key, args)
const modeLabels: Record<DesktopNormalMode, string> = {
  notify: '只提醒',
  once: '每个程序问一次',
  always: '每次都问',
}

function looseningText(change: DesktopSafetyLoosening): string {
  switch (change.kind) {
    case 'disable-guard':
      return ui('关闭桌面操作护栏')
    case 'normal-mode':
      return ui('普通区权限：{0} → {1}', [ui(modeLabels[change.from]), ui(modeLabels[change.to])])
    case 'trust':
      return ui('加入信任名单：{0}', [change.program])
    case 'unforbid':
      return ui('移出追加的禁区：{0}', [change.program])
    case 'unconfirm':
      return ui('移出追加的高危区：{0}', [change.program])
  }
}

function describe(request: GuardPrompt): DesktopApprovalView {
  const choice = (answer: GuardAnswer, label: string) => ({ answer, label: ui(label) })
  const deny = choice('deny', '拒绝')
  const approve = choice('approve', '允许')
  if (request.kind === 'action') {
    const recovery = request.zone.reason === 'draft-invalid'
    const highRisk = request.zone.zone === 'mustConfirm'
    let badge = request.manual ? '手动确认' : '普通区'
    if (recovery) badge = '保护规则待恢复'
    else if (highRisk) badge = '高危区'
    const choices = [deny, choice('once', '允许这一次')]
    if (request.ask === 'once') {
      choices.push(choice('thread', '本次对话都允许'), choice('trust', '以后都信任这个程序'))
    }
    return {
      title: ui('角色想操作你的电脑'),
      heading: request.zone.program || ui('无法识别的程序'),
      badge: ui(badge),
      warning: recovery || highRisk,
      detail: recovery
        ? [request.detail, ui('请在「桌面权限与安全」中检查保护规则。')].filter(Boolean).join('\n')
        : request.detail,
      choices,
    }
  }
  if (request.kind === 'plan') {
    const lines = [request.purpose, ui('预批：{0}', [request.covered.join('、')])]
    if (request.excluded.length)
      lines.push(ui('不在预批范围（每次单独确认或禁止）：{0}', [request.excluded.join('、')]))
    return {
      title: ui('任务预批'),
      heading: ui('允许角色在本次任务中操作这些程序？'),
      detail: lines.filter(Boolean).join('\n'),
      choices: [deny, approve],
    }
  }
  if (request.kind === 'enable-control') {
    return {
      title: ui('打开桌面操作'),
      heading: ui('允许角色截图并操作你的电脑？'),
      detail: ui('只有在你本人打开这个开关时才确认。不确定请点拒绝。'),
      choices: [deny, choice('approve', '打开')],
    }
  }
  const changes = request.changes.map(looseningText)
  const settings = request.recovery ? request.settings : undefined
  if (settings) {
    if (settings.enabled === false && !request.changes.some((change) => change.kind === 'disable-guard'))
      changes.push(ui('关闭桌面操作护栏'))
    changes.push(
      ui('普通区权限：{0}', [ui(modeLabels[settings.normalMode])]),
      ui('信任程序：{0}', [settings.trusted.join('、') || '—']),
      ui('追加禁区：{0}', [settings.forbidden.join('、') || '—']),
      ui('追加高危区：{0}', [settings.mustConfirm.join('、') || '—']),
    )
  }
  const sourceTitles = {
    agent: '角色申请放宽桌面操作权限：',
    file: '设置文件在应用外被修改，其中包含放宽的改动：',
    user: '确认放宽桌面操作权限：',
  }
  return {
    title: ui(request.recovery ? '恢复桌面安全设置' : '放宽桌面操作权限'),
    heading: ui(request.recovery ? '这些设置尚未在本次启动中确认。是否恢复？' : sourceTitles[request.source]),
    detail: changes.join('\n'),
    choices: [deny, approve],
  }
}

/** 页面只有静态骨架。审批详情只从本窗口的主帧读取，避免将用户输入或 URL 写进页面地址。 */
function approvalPage(): string {
  const theme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  const page = `<!doctype html><html lang="${getLocale()}" data-theme="${theme}"><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'">
    <style>${tokens}\n${style}</style></head><body>
    <header><span class="mark" aria-hidden="true">${brandMark}</span><b>infOS</b><span id="title"></span></header>
    <main><section><h1 id="heading"></h1><span id="badge" hidden></span></section><div id="detail"></div></main>
    <footer><div id="extended" hidden></div><div id="actions"></div></footer></body></html>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(page)}`
}

async function showPrompt(request: GuardPrompt): Promise<GuardAnswer> {
  const view = describe(request)
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  const width = Math.min(520, area.width)
  const win = new BrowserWindow({
    width,
    height: 240,
    title: view.title,
    show: false,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/desktopApproval.js'),
      partition: 'infos-desktop-approval',
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false,
    },
  })
  win.setMenu(null)
  const contents = win.webContents
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', (event) => event.preventDefault())
  return new Promise<GuardAnswer>((resolve) => {
    let settled = false
    const finish = (answer: GuardAnswer) => {
      if (settled) return
      settled = true
      clearTimeout(startup)
      if (!win.isDestroyed()) win.destroy()
      resolve(answer)
    }
    // preload 或页面加载失败时同样结束这次请求，后续审批可以继续。
    const startup = setTimeout(() => finish('deny'), 15_000)
    contents.ipc.handle('desktop-approval:read', (event) => {
      if (event.senderFrame !== contents.mainFrame) throw new Error('DESKTOP_SAFETY_FORBIDDEN')
      return view
    })
    contents.ipc.once('desktop-approval:ready', (event, requested: number) => {
      if (event.senderFrame !== contents.mainFrame || !Number.isFinite(requested)) return finish('deny')
      clearTimeout(startup)
      const height = Math.min(area.height, 600, Math.max(200, Math.ceil(requested)))
      win.setBounds({
        width, height,
        x: area.x + Math.round((area.width - width) / 2),
        y: area.y + Math.round((area.height - height) / 2),
      })
      win.show()
      win.focus()
    })
    contents.ipc.on('desktop-approval:answer', (event, value: unknown) => {
      if (event.senderFrame !== contents.mainFrame || !win.isFocused()) return
      finish(view.choices.find((choice) => choice.answer === value)?.answer ?? 'deny')
    })
    contents.on('render-process-gone', () => finish('deny'))
    win.once('closed', () => finish('deny'))
    void win.loadURL(approvalPage()).catch(() => finish('deny'))
  })
}

// 每次只展示一项审批，关闭、崩溃或加载失败均按拒绝处理。
let previous: Promise<unknown> = Promise.resolve()
export function showDesktopGuardPrompt(request: GuardPrompt): Promise<GuardAnswer> {
  const result = previous.then(() => showPrompt(request)).catch((): GuardAnswer => 'deny')
  previous = result
  return result
}
