/**
 * @file 桌面卡片 preload
 * @description 卡片页面唯一的对外接口 `window.infosCard`，以及常显拖动把手。
 *
 *              - `data(name)`：读取白名单内的只读数据；`onData(name, callback)`：订阅，最快每 10 秒一次；
 *                `openPage(pageId)`：在主窗口打开功能页，只能由用户点击触发。
 *              - `send(text)`：用户操作后给绑定会话发消息；`onData(callback)` 订阅版本化快照，
 *                返回取消函数，也可用 `unsubscribe(callback?)`；身份、凭据与限流均由主进程掌握。
 *              - `toast(message)`：以卡片名称为标题发出 infOS 桌面通知（正文限长、限频，不用 `alert`）；
 *                `close()`：关闭本卡片（未收藏的进最近关闭）；`togglePin()`：切换置顶，只能由用户点击触发。
 *              - 标题栏放在封闭的 Shadow DOM 中（名称、收藏、置顶、关闭），只响应真实的用户点击；
 *                收藏与置顶状态在标题栏常显；
 *                卡片脚本移除它时自动放回；宿主元素的定位与显示用内联 `!important` 写入，
 *                页面样式（含 `!important`）覆盖不了，被改写时恢复。
 *              - 页面仍可能用全屏遮罩挡住标题栏，所以另有不依赖卡片页面的关闭方式：
 *                Ctrl/Cmd+W（主进程拦截）与设置页的卡片列表。
 *              - 不暴露 ipcRenderer，也不暴露任何其他通道。
 *
 * @platform ELECTRON
 * @see .docs/P03_DESKTOP_SHELL.md 阶段 4
 * @module electron/preload/card
 */

import { contextBridge, ipcRenderer } from 'electron'
import { cardHome } from './cardHome'
import { showCardError, installCardDiagnostics } from './cardDiagnostics'
import { installCardKit } from './cardKit'
import uiTokens from '../../packages/frontend/src/assets/ui-tokens.css?raw'
import windowChrome from '../../packages/frontend/src/assets/aux-window.css?raw'
import { windowIconPaths } from '../../packages/frontend/src/components/pixel/windowIconPaths'
import cardChrome from './cardChrome.css?raw'
import {
  DESKTOP_CARD_CHANNELS,
  DESKTOP_CARD_LIMITS,
  isDesktopCardDataName,
} from '../../packages/shared/src/desktopCards'

type DataCallback = (value: unknown) => void

const subscriptions = new Map<string, { callbacks: Set<DataCallback>; timer: number }>()

function read(name: unknown): Promise<unknown> {
  if (!isDesktopCardDataName(name)) return Promise.reject(new Error('DESKTOP_CARD_INVALID_DATA'))
  return ipcRenderer.invoke(DESKTOP_CARD_CHANNELS.data, name)
}

function poll(name: string): void {
  const entry = subscriptions.get(name)
  if (!entry) return
  read(name).then(
    (value) => {
      for (const callback of entry.callbacks) {
        try {
          callback(value)
        } catch {
          // 卡片回调自身的错误不影响其他订阅。
        }
      }
    },
    () => undefined,
  )
}

contextBridge.exposeInMainWorld('infosCard', {
  data: (name: unknown) => read(name),
  onData: (name: unknown, callback: unknown) => {
    if (typeof name === 'function')
      return cardHome.onData(name as Parameters<typeof cardHome.onData>[0])
    if (!isDesktopCardDataName(name) || typeof callback !== 'function')
      throw new Error('DESKTOP_CARD_INVALID_DATA')
    let entry = subscriptions.get(name)
    if (!entry) {
      if (subscriptions.size >= DESKTOP_CARD_LIMITS.subscriptions)
        throw new Error('DESKTOP_CARD_TOO_MANY_SUBSCRIPTIONS')
      entry = {
        callbacks: new Set(),
        timer: window.setInterval(() => poll(name), DESKTOP_CARD_LIMITS.subscribeIntervalMs),
      }
      subscriptions.set(name, entry)
    }
    entry.callbacks.add(callback as DataCallback)
    poll(name)
    return () => {
      const current = subscriptions.get(name)
      if (!current) return
      current.callbacks.delete(callback as DataCallback)
      if (!current.callbacks.size) {
        window.clearInterval(current.timer)
        subscriptions.delete(name)
      }
    }
  },
  send: cardHome.send,
  unsubscribe: cardHome.unsubscribe,
  openPage: (pageId: unknown) => {
    // 只能由用户点击等真实操作触发，卡片脚本不能自行弹出页面。
    if (!navigator.userActivation?.isActive)
      return Promise.reject(new Error('DESKTOP_CARD_USER_ACTIVATION_REQUIRED'))
    return ipcRenderer.invoke(DESKTOP_CARD_CHANNELS.openPage, pageId)
  },
  toast: (message: unknown) => {
    // 主进程会再次校验长度与频率；这里先挡掉非字符串，避免把任意对象送过 IPC。
    if (typeof message !== 'string' || !message.trim())
      return Promise.reject(new Error('DESKTOP_CARD_INVALID_TOAST'))
    return ipcRenderer.invoke(DESKTOP_CARD_CHANNELS.control, 'toast', message)
  },
  close: () => ipcRenderer.invoke(DESKTOP_CARD_CHANNELS.control, 'close'),
  togglePin: () => {
    // 置顶会改变用户桌面，只能由用户点击等真实操作触发。
    if (!navigator.userActivation?.isActive)
      return Promise.reject(new Error('DESKTOP_CARD_USER_ACTIVATION_REQUIRED'))
    return ipcRenderer.invoke(DESKTOP_CARD_CHANNELS.control, 'pin')
  },
})

// ─── 常显把手与标题栏 ───────────────────────────────

interface CardInfo {
  name: string
  homeBound?: boolean
  saved: boolean
  alwaysOnTop: boolean
  labels: {
    save: string
    unsave: string
    pin: string
    close: string
    drag: string
    error: string
    dismiss: string
    retry: string
    unbound: string
    failed: string
  }
}

/** 宿主元素的内联样式（`!important`）：页面样式表即使带 `!important` 也覆盖不了内联的 `!important`。 */
const HOST_STYLE: ReadonlyArray<[string, string]> = [
  ['all', 'initial'],
  ['display', 'block'],
  ['position', 'fixed'],
  ['top', '0'],
  ['left', '0'],
  ['right', '0'],
  ['height', '26px'],
  ['z-index', '2147483647'],
  ['visibility', 'visible'],
  ['opacity', '1'],
  ['pointer-events', 'auto'],
  ['transform', 'none'],
  ['filter', 'none'],
  ['clip-path', 'none'],
]

function styleHost(host: HTMLElement): void {
  // 宿主元素只保留 style，hidden、inert、class 等一律移除。
  for (const name of host.getAttributeNames()) if (name !== 'style') host.removeAttribute(name)
  host.style.cssText = ''
  for (const [name, value] of HOST_STYLE) host.style.setProperty(name, value, 'important')
}

function icon(name: keyof typeof windowIconPaths): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(ns, 'path')
  path.setAttribute('d', windowIconPaths[name])
  svg.append(path)
  return svg
}

function installBar(): void {
  installCardKit()
  const host = document.createElement('infos-card-bar')
  styleHost(host)
  const expected = host.style.cssText
  const root = host.attachShadow({ mode: 'closed' })
  const shell = document.createElement('div')
  shell.className = 'card-shell'
  const theme = window.matchMedia('(prefers-color-scheme: dark)')
  const syncTheme = () => {
    shell.dataset.theme = theme.matches ? 'dark' : 'light'
  }
  syncTheme()
  theme.addEventListener('change', syncTheme)
  const setDiagnosticLabels = installCardDiagnostics(shell, () => {
    void ipcRenderer.invoke(DESKTOP_CARD_CHANNELS.control, 'reload').catch(showCardError)
  })
  const style = document.createElement('style')
  style.textContent = [uiTokens, windowChrome, cardChrome].join('\n')
  const bar = document.createElement('div')
  bar.className = 'aux-bar'
  const name = document.createElement('span')
  name.className = 'aux-title'
  const grip = document.createElement('span')
  grip.className = 'aux-mark'
  grip.append(icon('panels'))
  const controls = document.createElement('div')
  controls.className = 'aux-controls'
  const button = (action: 'save' | 'pin' | 'close') => {
    const element = document.createElement('button')
    element.type = 'button'
    element.className = action === 'close' ? 'aux-button aux-button--close' : 'aux-button'
    element.append(icon(action === 'save' ? 'star' : action))
    element.addEventListener('click', (event) => {
      // 卡片脚本合成的点击无效。
      if (!event.isTrusted) return
      void ipcRenderer.invoke(DESKTOP_CARD_CHANNELS.control, action).catch(() => undefined)
    })
    return element
  }
  const save = button('save')
  const pin = button('pin')
  const close = button('close')
  controls.append(save, pin, close)
  bar.append(grip, name, controls)
  shell.prepend(bar)
  root.append(style, shell)

  let homeStarted = false
  const apply = (info: CardInfo) => {
    setDiagnosticLabels(info.labels)
    bar.title = info.labels.drag
    name.textContent = info.name
    name.title = info.name
    save.title = info.saved ? info.labels.unsave : info.labels.save
    save.setAttribute('aria-label', save.title)
    save.setAttribute('aria-pressed', String(info.saved))
    pin.title = info.labels.pin
    pin.setAttribute('aria-label', pin.title)
    pin.setAttribute('aria-pressed', String(info.alwaysOnTop))
    close.title = info.labels.close
    close.setAttribute('aria-label', close.title)
    if (info.homeBound && !homeStarted) {
      homeStarted = true
      cardHome.start(showCardError)
    }
  }
  ipcRenderer.on(DESKTOP_CARD_CHANNELS.changed, (_event, info: CardInfo) => apply(info))
  void ipcRenderer
    .invoke(DESKTOP_CARD_CHANNELS.info)
    .then((info: CardInfo) => apply(info))
    .catch(() => undefined)

  let feedback: number | undefined
  const pulse = () => {
    bar.classList.add('updated')
    window.clearTimeout(feedback)
    feedback = window.setTimeout(() => bar.classList.remove('updated'), 500)
  }
  window.addEventListener('infos-card-updated', pulse)
  window.addEventListener('infos-card-message-received', pulse)

  // 挂在 <html> 上，卡片替换 body 时不受影响；被移除时放回。
  const attach = () => {
    if (!host.isConnected) document.documentElement.append(host)
  }
  attach()
  new MutationObserver(attach).observe(document, { childList: true, subtree: true })
  // 卡片脚本改写宿主元素的样式或属性时恢复；只在确有变化时写入，避免观察者自我触发。
  new MutationObserver(() => {
    if (
      host.style.cssText !== expected ||
      host.getAttributeNames().some((name) => name !== 'style')
    )
      styleHost(host)
  }).observe(host, { attributes: true })
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installBar)
else installBar()
