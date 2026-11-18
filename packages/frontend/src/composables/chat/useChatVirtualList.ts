import {
  computed,
  inject,
  nextTick,
  onActivated,
  onDeactivated,
  onMounted,
  onUnmounted,
  ref,
  shallowRef,
  watch,
  type Ref,
} from 'vue'
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/vue-virtual'
import type { ChatMessage } from '../../stores/useThreadStore'
import { useCompositorStore } from '../../stores/useCompositorStore'
import type { SurfaceId } from '@infos/shared'
import { useEventListener } from '../useEventListener'

/** 消息尺寸由实际行测量；展开详情、选区、焦点与播放中的行继续挂载。 */
export function useChatVirtualList(options: {
  container: Ref<HTMLElement | null>
  messages: Ref<ChatMessage[]>
  scope: () => string
  renderKey: (id: string) => string
  generating: Ref<boolean>
  playingMessage: Ref<string | null>
  following: Ref<boolean>
  scrollToBottom: (smooth?: boolean) => void
}) {
  const mainVisible = inject('infos:main-surface-visible', shallowRef(true))
  const compositor = useCompositorStore()
  const active = ref(true)
  const expanded = shallowRef(new Set<string>())
  const media = shallowRef(new Set<string>())
  const selectionKeys = shallowRef<string[]>([])
  const focusedKey = ref<string>()
  const keys = computed<string[]>((previous) => {
    const next = options.messages.value.map(
      (message) => `${options.scope()}:${options.renderKey(message.id)}`,
    )
    return previous && previous.length === next.length && next.every((key, index) => key === previous[index])
      ? previous
      : next
  })
  let savedOffset = 0
  let disposed = false

  const pinned = computed<number[]>((previous) => {
    const indices = new Set<number>()
    const selected = selectionKeys.value.map((key) => keys.value.indexOf(key)).filter((i) => i >= 0)
    if (selected.length) {
      const start = Math.min(...selected)
      const end = Math.max(...selected)
      for (let i = start; i <= end; i++) indices.add(i)
    }
    options.messages.value.forEach((message, index) => {
      const key = keys.value[index]!
      if (
        expanded.value.has(key) || media.value.has(key) || focusedKey.value === key ||
        message.id === options.playingMessage.value ||
        (message.surfaceId && compositor.pinnedSurfaceIds.has(message.surfaceId as SurfaceId)) ||
        (options.generating.value && index === options.messages.value.length - 1)
      ) indices.add(index)
    })
    const next = [...indices].sort((a, b) => a - b)
    return previous && previous.length === next.length && next.every((index, offset) => index === previous[offset])
      ? previous
      : next
  })

  const virtualizer = useVirtualizer<HTMLElement, HTMLElement>(computed(() => {
    // 捕获这一版身份，头部补页时让内核能同时读取新旧索引。
    const currentKeys = keys.value
    const keep = pinned.value
    return {
      count: currentKeys.length,
      getScrollElement: () => options.container.value,
      getItemKey: (index: number) => currentKeys[index]!,
      estimateSize: (index: number) => options.messages.value[index]?.role === 'user' ? 110 : 220,
      initialOffset: () => savedOffset,
      overscan: 5,
      gap: 4,
      paddingStart: 24,
      paddingEnd: 20,
      anchorTo: 'end' as const,
      followOnAppend: false,
      enabled: active.value && mainVisible.value,
      rangeExtractor: (range: Parameters<typeof defaultRangeExtractor>[0]) =>
        [...new Set([...defaultRangeExtractor(range), ...keep])].sort((a, b) => a - b),
    }
  }))
  type Row = { key: string; index: number; gapBefore: number; message: ChatMessage }
  let retainedRows: Row[] = []
  let retainedBottom = 0
  const rows = computed(() => {
    if (!active.value || !mainVisible.value) return retainedRows
    const items = virtualizer.value.getVirtualItems()
    retainedRows = []
    let previousEnd = 0
    for (const item of items) {
      const message = options.messages.value[item.index]
      if (!message || item.key !== keys.value[item.index]) continue
      retainedRows.push({
        key: String(item.key), index: item.index, message,
        gapBefore: Math.max(0, item.start - previousEnd),
      })
      previousEnd = item.end
    }
    return retainedRows
  })
  const bottomSpace = computed(() => {
    if (active.value && mainVisible.value) {
      const last = virtualizer.value.getVirtualItems().at(-1)
      retainedBottom = Math.max(0, virtualizer.value.getTotalSize() - (last?.end ?? 0))
    }
    return retainedBottom
  })

  function rowFor(node: Node | null): HTMLElement | null {
    const element = node instanceof Element ? node : node?.parentElement
    const row = element?.closest<HTMLElement>('[data-chat-key]')
    return row && options.container.value?.contains(row) ? row : null
  }
  function setMembership(target: Ref<Set<string>>, key: string, included: boolean): void {
    if (target.value.has(key) === included) return
    const next = new Set(target.value)
    if (included) next.add(key)
    else next.delete(key)
    target.value = next
  }
  function syncExpanded(row: HTMLElement): void {
    if (!row.isConnected || !row.dataset.chatKey) return
    setMembership(expanded, row.dataset.chatKey, !!row.querySelector('details[open], [aria-expanded="true"]'))
  }
  function measureRow(element: unknown): void {
    if (!(element instanceof HTMLElement)) {
      virtualizer.value.measureElement(null)
      return
    }
    virtualizer.value.measureElement(element)
    void nextTick(() => syncExpanded(element))
  }
  function syncSelection(): void {
    const selection = window.getSelection()
    selectionKeys.value = selection && !selection.isCollapsed
      ? [rowFor(selection.anchorNode)?.dataset.chatKey, rowFor(selection.focusNode)?.dataset.chatKey]
        .filter((key): key is string => !!key)
      : []
  }
  function syncFocus(): void {
    focusedKey.value = rowFor(document.activeElement)?.dataset.chatKey
  }
  function syncMedia(event: Event): void {
    const row = event.target instanceof Node ? rowFor(event.target) : null
    if (!row?.dataset.chatKey) return
    const playing = [...row.querySelectorAll<HTMLMediaElement>('audio, video')]
      .some((element) => (!element.paused && !element.ended) || element.dataset.wasPlaying === 'true')
    setMembership(media, row.dataset.chatKey, playing)
  }

  // 展开的详情保留真实 DOM，关闭后重新交给可见范围回收。
  const expansionObserver = typeof MutationObserver === 'undefined' ? undefined : new MutationObserver((records) => {
    const changed = new Set<HTMLElement>()
    for (const record of records) {
      const row = rowFor(record.target)
      if (row) changed.add(row)
    }
    for (const row of changed) syncExpanded(row)
  })
  watch(options.container, (container) => {
    expansionObserver?.disconnect()
    if (container) expansionObserver?.observe(container, {
      subtree: true, attributes: true, attributeFilter: ['open', 'aria-expanded'],
    })
  }, { flush: 'post' })
  useEventListener(document, 'selectionchange', syncSelection)
  useEventListener(options.container, 'focusin', syncFocus)
  useEventListener(options.container, 'focusout', () => { void nextTick(syncFocus) })
  useEventListener(options.container, 'play', syncMedia, { capture: true })
  useEventListener(options.container, 'pause', syncMedia, { capture: true })
  useEventListener(options.container, 'ended', syncMedia, { capture: true })

  async function remeasure(): Promise<void> {
    if (disposed || !active.value || !mainVisible.value) return
    const owner = options.scope()
    const top = options.container.value?.scrollTop ?? 0
    const anchor = virtualizer.value.getVirtualItems().find((item) => item.end > top)
    const offset = anchor ? top - anchor.start : 0
    const following = options.following.value && !selectionKeys.value.length
    virtualizer.value.measure()
    await nextTick()
    if (disposed || options.scope() !== owner || !active.value || !mainVisible.value) return
    for (const element of options.container.value?.querySelectorAll<HTMLElement>('[data-chat-key]') ?? []) {
      virtualizer.value.measureElement(element)
    }
    await nextTick()
    if (disposed || options.scope() !== owner || !active.value || !mainVisible.value) return
    if (following) options.scrollToBottom(false)
    else if (anchor) {
      const index = keys.value.indexOf(String(anchor.key))
      const target = index >= 0 ? virtualizer.value.getOffsetForIndex(index, 'start') : undefined
      if (target) virtualizer.value.scrollToOffset(target[0] + offset)
    }
  }
  let measuredWidth = 0
  watch(() => virtualizer.value.scrollRect?.width, (width) => {
    if (!width) return
    if (measuredWidth && width !== measuredWidth) void remeasure()
    measuredWidth = width
  })
  watch(options.scope, () => {
    savedOffset = 0
    expanded.value = new Set()
    media.value = new Set()
    selectionKeys.value = []
    focusedKey.value = undefined
    virtualizer.value.measure()
  }, { flush: 'pre' })
  watch(mainVisible, (visible) => {
    if (!visible) savedOffset = options.container.value?.scrollTop ?? savedOffset
    else void nextTick(remeasure)
  }, { flush: 'sync' })
  onMounted(() => {
    document.fonts?.addEventListener('loadingdone', remeasure)
    void document.fonts?.ready.then(remeasure)
  })
  onActivated(() => {
    active.value = true
    void nextTick(remeasure)
  })
  onDeactivated(() => {
    savedOffset = options.container.value?.scrollTop ?? savedOffset
    active.value = false
  })
  onUnmounted(() => {
    disposed = true
    expansionObserver?.disconnect()
    document.fonts?.removeEventListener('loadingdone', remeasure)
  })

  return { virtualizer, rows, bottomSpace, measureRow }
}
