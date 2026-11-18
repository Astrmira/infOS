import type { ObjectDirective } from 'vue'
import type { PreparedText } from '@chenglou/pretext'

interface TextLayoutInput {
  enabled: boolean
  html?: string
  locale: string
}

interface TextLayoutState {
  input: TextLayoutInput
  width: number
  skipped?: boolean
  native?: { html: string; width: number; height: number; epoch: number }
}

const states = new Map<HTMLElement, TextLayoutState>()
const pending = new Set<HTMLElement>()
const preparedTexts = new Map<string, { value: PreparedText; chars: number }>()
const MAX_PREPARED_ENTRIES = 256
const MAX_PREPARED_CHARS = 200_000
let preparedChars = 0
let preparedLocale = ''
let typographyEpoch = 0
let frame = 0
let resizeObserver: ResizeObserver | undefined
let typographyObserver: MutationObserver | undefined
let pretext: typeof import('@chenglou/pretext') | undefined
let loading: Promise<void> | undefined

function loadPretext(): void {
  if (pretext || loading) return
  loading = import('@chenglou/pretext')
    .then((module) => {
      pretext = module
      for (const element of states.keys()) schedule(element)
    })
    .catch(() => { /* 测量模块加载失败时保留浏览器布局，后续挂载可重新加载。 */ })
    .finally(() => { loading = undefined })
}

/** 缓存文字与字体的准备结果，宽度变化时复用分段及字宽。 */
function preparedText(text: string, font: string, letterSpacing: number, locale: string): PreparedText {
  const key = JSON.stringify([locale, font, letterSpacing, text])
  const cached = preparedTexts.get(key)
  if (cached) {
    preparedTexts.delete(key)
    preparedTexts.set(key, cached)
    return cached.value
  }
  if (preparedLocale !== locale) {
    pretext!.setLocale(locale)
    preparedLocale = locale
  }
  const value = pretext!.prepare(text, font, { letterSpacing })
  const chars = key.length + text.length
  if (chars <= MAX_PREPARED_CHARS) {
    preparedTexts.set(key, { value, chars })
    preparedChars += chars
    while (preparedTexts.size > MAX_PREPARED_ENTRIES || preparedChars > MAX_PREPARED_CHARS) {
      const oldest = preparedTexts.keys().next().value!
      preparedChars -= preparedTexts.get(oldest)!.chars
      preparedTexts.delete(oldest)
    }
  }
  return value
}

function resetStyles(element: HTMLElement): void {
  element.style.removeProperty('content-visibility')
  element.style.removeProperty('contain-intrinsic-inline-size')
  element.style.removeProperty('contain-intrinsic-block-size')
}

/** 首批覆盖纯文字段落及显式换行，其他富内容继续使用所属组件的布局。 */
function plainParagraphs(element: HTMLElement): HTMLParagraphElement[] | undefined {
  if (!element.children.length || !element.closest('.msg-bubble-assistant')) return
  const paragraphs: HTMLParagraphElement[] = []
  for (const child of element.childNodes) {
    if (child.nodeType === Node.TEXT_NODE && !child.textContent?.trim()) continue
    if (!(child instanceof HTMLParagraphElement)) return
    if ([...child.children].some((inline) => inline.tagName !== 'BR')) return
    paragraphs.push(child)
  }
  return paragraphs.length ? paragraphs : undefined
}

function paragraphParts(paragraph: HTMLParagraphElement): string[] {
  const parts = ['']
  for (const node of paragraph.childNodes) {
    if (node.nodeName === 'BR') parts.push('')
    else parts[parts.length - 1] += node.textContent ?? ''
  }
  // 浏览器中段末 br 结束当前行，末尾的空白片段由前一行承载。
  if (parts.length > 1 && !parts.at(-1)!.trim()) parts.pop()
  return parts
}

function measure(element: HTMLElement, state: TextLayoutState): { height: number; width: number } | undefined {
  const paragraphs = plainParagraphs(element)
  if (!pretext || !paragraphs || state.width <= 0) return
  if (getComputedStyle(element).writingMode !== 'horizontal-tb') return
  let height = 0
  let naturalWidth = 0
  let previousMargin = 0
  for (const paragraph of paragraphs) {
    const style = getComputedStyle(paragraph)
    if (style.whiteSpace !== 'normal' || !['normal', 'break-word'].includes(style.wordBreak) ||
        !['anywhere', 'break-word'].includes(style.overflowWrap) || style.lineBreak !== 'auto' ||
        !['normal', '100%'].includes(style.fontStretch) ||
        style.textTransform !== 'none' || style.textIndent !== '0px' || style.hyphens === 'auto' ||
        style.fontFeatureSettings !== 'normal' || style.fontVariationSettings !== 'normal' ||
        style.fontVariant !== 'normal' || !['normal', '0px'].includes(style.wordSpacing) ||
        ['balance', 'pretty'].includes(style.textWrapStyle) ||
        [style.paddingTop, style.paddingBottom, style.paddingLeft, style.paddingRight,
          style.borderTopWidth, style.borderBottomWidth, style.borderLeftWidth, style.borderRightWidth,
          style.marginLeft, style.marginRight].some((value) => parseFloat(value) !== 0)) return
    const lineHeight = parseFloat(style.lineHeight)
    const marginTop = parseFloat(style.marginTop)
    const marginBottom = parseFloat(style.marginBottom)
    if (!Number.isFinite(lineHeight) || lineHeight <= 0 || marginTop < 0 || marginBottom < 0) return
    if (paragraph === paragraphs[0] && marginTop !== 0) return
    if (paragraph === paragraphs.at(-1) && marginBottom !== 0) return
    const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
    const letterSpacing = style.letterSpacing === 'normal' ? 0 : parseFloat(style.letterSpacing)
    if (!Number.isFinite(letterSpacing) || !document.fonts.check(font, paragraph.textContent ?? '')) return
    const locale = paragraph.closest('[lang]')?.getAttribute('lang') || state.input.locale
    const parts = paragraphParts(paragraph)
    const minimumLines = parts.length > 1 || paragraph.querySelector('br') ? 1 : 0
    let paragraphHeight = 0
    for (const text of parts) {
      const prepared = preparedText(text, font, letterSpacing, locale)
      paragraphHeight += Math.max(minimumLines, pretext.layout(prepared, state.width, lineHeight).lineCount) * lineHeight
      naturalWidth = Math.max(naturalWidth, pretext.measureNaturalWidth(prepared))
    }
    height += Math.max(previousMargin, marginTop) + paragraphHeight
    previousMargin = marginBottom
  }
  height += previousMargin
  const native = state.native
  if (native && native.html === state.input.html && native.width === state.width && native.epoch === typographyEpoch)
    height = native.height
  return height > 0 && Number.isFinite(height) && Number.isFinite(naturalWidth)
    ? { height, width: Math.ceil(naturalWidth) }
    : undefined
}

function flush(): void {
  frame = 0
  // 先集中读取排版参数，再统一写入占位尺寸，避免读写交错触发重复布局。
  const measurements = [...pending].map((element) => {
    const state = states.get(element)
    let size: ReturnType<typeof measure>
    if (state && element.isConnected) {
      try { size = measure(element, state) } catch { /* 字体或测量能力暂不可用时使用浏览器布局。 */ }
    }
    return { element, size }
  })
  pending.clear()
  for (const { element, size } of measurements) {
    if (!size) {
      resetStyles(element)
      continue
    }
    element.style.setProperty('contain-intrinsic-inline-size', `${size.width}px`)
    element.style.setProperty('contain-intrinsic-block-size', `${size.height}px`)
    element.style.setProperty('content-visibility', 'auto')
  }
}

function schedule(element: HTMLElement): void {
  pending.add(element)
  if (!frame) frame = requestAnimationFrame(flush)
}

function invalidateTypography(): void {
  typographyEpoch++
  pretext?.clearCache()
  preparedTexts.clear()
  preparedChars = 0
  preparedLocale = ''
  for (const element of states.keys()) schedule(element)
}

function startObservers(): void {
  if (resizeObserver) return
  resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const element = entry.target as HTMLElement
      const state = states.get(element)
      if (!state) continue
      const { width, height } = entry.contentRect
      let changed = state.width !== width
      state.width = width
      // 可见状态下的真实高度优先，离屏占位不会反向污染实际尺寸缓存。
      if (width > 0 && (element.style.contentVisibility !== 'auto' || state.skipped === false)) {
        changed ||= state.native?.height !== height || state.native?.epoch !== typographyEpoch
        state.native = { html: state.input.html ?? '', width, height, epoch: typographyEpoch }
      }
      if (changed) schedule(element)
    }
  })
  typographyObserver = new MutationObserver(invalidateTypography)
  typographyObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['lang', 'class', 'style', 'data-theme'],
  })
  document.fonts.addEventListener('loadingdone', invalidateTypography)
  document.fonts.addEventListener('loadingerror', invalidateTypography)
}

function visibilityChanged(event: Event): void {
  const element = event.currentTarget as HTMLElement
  const state = states.get(element)
  if (!state) return
  state.skipped = (event as Event & { skipped: boolean }).skipped
  if (!state.skipped) schedule(element)
}

function detach(element: HTMLElement): void {
  if (!states.delete(element)) return
  resizeObserver?.unobserve(element)
  element.removeEventListener('contentvisibilityautostatechange', visibilityChanged)
  pending.delete(element)
  resetStyles(element)
  if (states.size) return
  resizeObserver?.disconnect()
  resizeObserver = undefined
  typographyObserver?.disconnect()
  typographyObserver = undefined
  document.fonts.removeEventListener('loadingdone', invalidateTypography)
  document.fonts.removeEventListener('loadingerror', invalidateTypography)
  if (frame) cancelAnimationFrame(frame)
  frame = 0
  invalidateTypography()
}

function update(element: HTMLElement, input: TextLayoutInput): void {
  if (!input.enabled || !input.html || input.html.length > MAX_PREPARED_CHARS || !plainParagraphs(element) ||
      typeof ResizeObserver === 'undefined' || !('oncontentvisibilityautostatechange' in element) ||
      typeof CSS === 'undefined' || !CSS.supports('content-visibility', 'auto') || !document.fonts) {
    if (states.has(element)) detach(element)
    return
  }
  const state = states.get(element)
  if (state) {
    if (state.input.html === input.html && state.input.locale === input.locale) return
    state.input = input
    state.native = undefined
    resetStyles(element)
    schedule(element)
    return
  }
  states.set(element, { input, width: 0 })
  loadPretext()
  startObservers()
  element.addEventListener('contentvisibilityautostatechange', visibilityChanged)
  resizeObserver!.observe(element)
}

/** 已完成助手文本的布局缓存，直接挂在安全 HTML 根节点上。 */
export const chatTextLayout: ObjectDirective<HTMLElement, TextLayoutInput> = {
  mounted: (element, binding) => update(element, binding.value),
  updated: (element, binding) => update(element, binding.value),
  beforeUnmount: detach,
}
