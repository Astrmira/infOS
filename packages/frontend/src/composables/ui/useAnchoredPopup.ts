import { autoUpdate } from '@floating-ui/vue'
import { onDeactivated, onScopeDispose, watch, type Ref } from 'vue'

interface AnchoredPopup {
  open: Ref<boolean>
  trigger: Ref<HTMLElement | null>
  panel: Ref<HTMLElement | null>
  /** 触发按钮旁边也属于控件的区域，例如选择器的标签。 */
  wrapper?: Ref<HTMLElement | null>
  disabled: () => boolean
  updatePosition: () => void
  onOpenKeydown?: (event: KeyboardEvent) => void
}

// 每个窗口只监听已打开的浮层。子面板 Teleport 到 body 后仍属于打开它的父面板。
const openLayers: AnchoredPopup[] = []

function closeFrom(index: number, restoreFocus = false): void {
  const trigger = openLayers[index]?.trigger.value
  for (const layer of openLayers.splice(index).reverse()) layer.open.value = false
  if (!openLayers.length) {
    document.removeEventListener('pointerdown', dismissOutside, true)
    document.removeEventListener('click', dismissOutside, true)
    document.removeEventListener('focusin', dismissOutside, true)
    document.removeEventListener('keydown', handleKeydown, true)
  }
  if (restoreFocus && trigger?.isConnected) trigger.focus({ preventScroll: true })
}

function dismissOutside(event: Event): void {
  // 从最上层向下找，点父面板只收起子层，点子面板保留整条父链。
  const path = event.composedPath()
  for (let i = openLayers.length - 1; i >= 0; i--) {
    const layer = openLayers[i]!
    const roots = [layer.trigger.value, layer.panel.value, layer.wrapper?.value]
    if (roots.some((element) => element && path.includes(element))) {
      if (i + 1 < openLayers.length) closeFrom(i + 1)
      return
    }
  }
  if (openLayers.length) closeFrom(0)
}

function handleKeydown(event: KeyboardEvent): void {
  const layer = openLayers.at(-1)
  if (!layer || event.isComposing || event.defaultPrevented) return
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    closeFrom(openLayers.length - 1, true)
  } else {
    layer.onOpenKeydown?.(event)
  }
}

/** 共用展开期间的事件和定位观察；尺寸、方向和选项导航由控件决定。 */
export function useAnchoredPopup(layer: AnchoredPopup) {
  function show(): boolean {
    const trigger = layer.trigger.value
    if (!trigger || layer.disabled()) return false
    if (layer.open.value) return true
    // 键盘或代码也可以打开浮层，此时可能没有外部指针事件替我们收起兄弟面板。
    let parent = openLayers.length - 1
    while (parent >= 0 && !openLayers[parent]!.panel.value?.contains(trigger)) parent--
    if (parent + 1 < openLayers.length) closeFrom(parent + 1)
    if (!openLayers.length) {
      document.addEventListener('pointerdown', dismissOutside, true)
      document.addEventListener('click', dismissOutside, true)
      document.addEventListener('focusin', dismissOutside, true)
      document.addEventListener('keydown', handleKeydown, true)
    }
    openLayers.push(layer)
    layer.open.value = true
    return true
  }

  function close(restoreFocus = false): void {
    const index = openLayers.indexOf(layer)
    if (index < 0) return
    closeFrom(index, restoreFocus)
  }

  watch(
    [layer.open, layer.trigger, layer.panel],
    ([open, trigger, panel], _previous, onCleanup) => {
      if (open && trigger && panel) onCleanup(autoUpdate(trigger, panel, layer.updatePosition))
    },
    { flush: 'post' },
  )
  watch(layer.disabled, (disabled) => {
    if (disabled) close()
  })
  onDeactivated(close)
  onScopeDispose(close)
  return { show, close }
}
