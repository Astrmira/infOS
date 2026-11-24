<script setup lang="ts">
import {
  computed,
  inject,
  onActivated,
  onBeforeUnmount,
  onDeactivated,
  onMounted,
  reactive,
  ref,
  watch,
} from 'vue'
import type { BrowserObserverFrame, BrowserObserverSession } from '@infos/shared'
import { browserObserverApi } from '../../api/modules/browserObserverApi'
import { t } from '../../i18n'
import { PButton, PixelIcon } from '../pixel'
import '../../assets/aux-window.css'
import { observerDisplay, setObserverDisplay, type ObserverDisplay } from './browserObserverVisibility'

const props = withDefaults(
  defineProps<{
    agentId: string
    threadId: string
    agentName?: string
    active?: boolean
    embedded?: boolean
  }>(),
  { active: true, embedded: false, agentName: '' },
)
const activated = ref(true)
const foreground = ref(typeof document !== 'undefined' && !document.hidden)
const mainVisible = inject('infos:main-surface-visible', ref(true))
const sessions = ref<BrowserObserverSession[]>([])
const selectedId = ref('')
const selectedManually = ref(false)
const selected = computed(
  () => sessions.value.find((item) => item.id === selectedId.value) ?? sessions.value[0],
)
const display = computed(() =>
  selected.value && observerDisplay(props.agentId, props.threadId, selected.value),
)
const running = computed(
  () =>
    activated.value &&
    foreground.value &&
    mainVisible.value &&
    props.active !== false &&
    !!props.threadId,
)
const frame = ref<BrowserObserverFrame>({ state: 'waiting' })
const image = ref('')
const live = computed(() => selected.value?.available && frame.value.state === 'live')
const rect = reactive({ x: 0, y: 0, width: 440, height: 320 })
const viewport = reactive({ width: 1024, height: 768 })
let positioned = false
let stopDiscovery: (() => void) | undefined
let stopFrames: (() => void) | undefined
let stopGesture: (() => void) | undefined

const status = computed(() => {
  if (!selected.value?.available || frame.value.state === 'paused')
    return t('ui.browser-observer', '画面已暂停，正在重连')
  if (frame.value.state === 'closed') return t('ui.browser-observer', '浏览器页面已关闭')
  if (frame.value.state === 'waiting') return t('ui.browser-observer', '等待浏览器画面')
  return t('ui.browser-observer', '只读实时画面')
})

function clampRect() {
  const maxWidth = Math.max(1, viewport.width - 16)
  const maxHeight = Math.max(1, viewport.height - 16)
  rect.width = Math.min(maxWidth, Math.max(Math.min(280, maxWidth), rect.width))
  rect.height = Math.min(maxHeight, Math.max(Math.min(200, maxHeight), rect.height))
  rect.x = Math.max(8, Math.min(rect.x, viewport.width - rect.width - 8))
  rect.y = Math.max(8, Math.min(rect.y, viewport.height - rect.height - 8))
}
function resizeViewport() {
  viewport.width = window.innerWidth
  viewport.height = window.innerHeight
  if (!positioned) {
    rect.x = viewport.width - rect.width - 24
    rect.y = Math.min(96, viewport.height / 5)
    positioned = true
  }
  clampRect()
}
function scale(factor: number) {
  rect.width *= factor
  rect.height *= factor
  clampRect()
}
function setDisplay(value: ObserverDisplay) {
  if (!selected.value) return
  stopGesture?.()
  setObserverDisplay(props.agentId, props.threadId, selected.value, value)
}

/** 拖动与缩放只更新观看端矩形，没有向浏览器发送尺寸或输入的入口。 */
function startGesture(event: PointerEvent, direction = '') {
  if (event.button !== 0 || (!direction && (event.target as HTMLElement).closest('button, select')))
    return
  event.preventDefault()
  stopGesture?.()
  const start = { ...rect, xPointer: event.clientX, yPointer: event.clientY }
  const move = (next: PointerEvent) => {
    if (next.pointerId !== event.pointerId) return
    const dx = next.clientX - start.xPointer
    const dy = next.clientY - start.yPointer
    if (!direction) {
      rect.x = start.x + dx
      rect.y = start.y + dy
    } else {
      rect.width = start.width + (direction.includes('w') ? -dx : direction.includes('e') ? dx : 0)
      rect.height =
        start.height + (direction.includes('n') ? -dy : direction.includes('s') ? dy : 0)
      clampRect()
      if (direction.includes('w')) rect.x = start.x + start.width - rect.width
      if (direction.includes('n')) rect.y = start.y + start.height - rect.height
    }
    clampRect()
  }
  const end = (next: PointerEvent) => {
    if (next.pointerId === event.pointerId) stopGesture?.()
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', end)
  window.addEventListener('pointercancel', end)
  stopGesture = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', end)
    window.removeEventListener('pointercancel', end)
    stopGesture = undefined
  }
}

watch(
  [running, () => props.agentId, () => props.threadId],
  ([enabled]) => {
    stopDiscovery?.()
    sessions.value = []
    selectedId.value = ''
    selectedManually.value = false
    if (!enabled) return
    const agentId = props.agentId
    const threadId = props.threadId
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    stopDiscovery = () => {
      controller.abort()
      clearTimeout(timer)
    }
    const poll = async () => {
      try {
        const response = await browserObserverApi.sessions(
          agentId,
          threadId,
          AbortSignal.any([controller.signal, AbortSignal.timeout(7_000)]),
        )
        if (controller.signal.aborted) return
        sessions.value = response.data ?? []
        if (!selectedManually.value || !sessions.value.some((item) => item.id === selectedId.value))
          selectedId.value = sessions.value[0]?.id ?? ''
      } catch {
        if (!controller.signal.aborted) {
          sessions.value = sessions.value.map((item) => ({ ...item, available: false }))
        }
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, 1_500)
      }
    }
    void poll()
  },
  { immediate: true },
)

watch(
  [running, display, () => selected.value?.id, () => selected.value?.available],
  () => {
    stopFrames?.()
    const session = selected.value
    image.value = ''
    frame.value = { state: 'waiting' }
    if (!running.value || display.value !== 'expanded' || !session?.available) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    stopFrames = () => {
      controller.abort()
      clearTimeout(timer)
    }
    const poll = async () => {
      try {
        const response = await browserObserverApi.frame(
          session.id,
          session.agentId,
          session.threadId,
          AbortSignal.any([controller.signal, AbortSignal.timeout(7_000)]),
        )
        if (controller.signal.aborted) return
        frame.value = response.data ?? { state: 'paused' }
        if (frame.value.state === 'live' && frame.value.dataUri) image.value = frame.value.dataUri
        if (frame.value.state === 'closed') image.value = ''
      } catch {
        if (!controller.signal.aborted) frame.value = { state: 'paused' }
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, 750)
      }
    }
    void poll()
  },
  { immediate: true },
)

function visibilityChanged() {
  foreground.value = !document.hidden
}
onMounted(() => {
  resizeViewport()
  window.addEventListener('resize', resizeViewport)
  document.addEventListener('visibilitychange', visibilityChanged)
})
onActivated(() => {
  activated.value = true
})
onDeactivated(() => {
  activated.value = false
  stopGesture?.()
})
onBeforeUnmount(() => {
  stopDiscovery?.()
  stopFrames?.()
  stopGesture?.()
  window.removeEventListener('resize', resizeViewport)
  document.removeEventListener('visibilitychange', visibilityChanged)
})
</script>

<template>
  <PButton
    v-if="running && display === 'closed'"
    type="button"
    variant="ghost"
    size="sm"
    :title="t('ui.browser-observer', '查看浏览器')"
    :aria-label="t('ui.browser-observer', '查看浏览器')"
    @click="setDisplay('expanded')"
  >
    <PixelIcon name="globe" size="xs" aria-hidden="true" />
    <span v-if="embedded">{{ t('ui.browser-observer', '查看浏览器') }}</span>
  </PButton>
  <Teleport to="body" :disabled="embedded">
    <template v-if="running && selected && display !== 'closed'">
      <div
        v-if="display === 'collapsed'"
        class="browser-observer-dock"
        :class="{ 'is-embedded': embedded }"
      >
        <button type="button" class="browser-observer-launcher" @click="setDisplay('expanded')">
          <span class="aux-mark"><PixelIcon name="globe" size="sm" aria-hidden="true" /></span>
          {{ t('ui.browser-observer', '查看浏览器') }}
        </button>
        <button
          type="button"
          class="aux-button aux-button--close"
          :title="t('ui.browser-observer', '关闭浏览器旁观')"
          :aria-label="t('ui.browser-observer', '关闭浏览器旁观')"
          @click="setDisplay('closed')"
        >
          <PixelIcon name="close" size="xs" aria-hidden="true" />
        </button>
      </div>
      <section
        v-else
        class="browser-observer"
        :class="{ 'is-embedded': embedded }"
        role="region"
        :aria-label="t('ui.browser-observer', '浏览器旁观小窗')"
        :style="{
          left: embedded ? undefined : `${rect.x}px`,
          top: embedded ? undefined : `${rect.y}px`,
          width: `${rect.width}px`,
          height: `${rect.height}px`,
        }"
      >
        <header
          class="aux-bar browser-observer-header"
          @pointerdown="!embedded && startGesture($event)"
        >
          <span class="aux-mark"><PixelIcon name="globe" size="sm" aria-hidden="true" /></span>
          <strong class="aux-title">{{ t('ui.browser-observer', '浏览器旁观') }}</strong>
          <div class="aux-controls">
            <button
              type="button"
              class="aux-button"
              :title="t('ui.browser-observer', '收起小窗')"
              :aria-label="t('ui.browser-observer', '收起小窗')"
              @click="setDisplay('collapsed')"
            >
              <PixelIcon name="chevron-down" size="sm" aria-hidden="true" />
            </button>
            <button
              type="button"
              class="aux-button aux-button--close"
              :title="t('ui.browser-observer', '关闭浏览器旁观')"
              :aria-label="t('ui.browser-observer', '关闭浏览器旁观')"
              @click="setDisplay('closed')"
            >
              <PixelIcon name="close" size="sm" aria-hidden="true" />
            </button>
          </div>
        </header>
        <div class="browser-observer-source">
          <PixelIcon name="user" size="xs" aria-hidden="true" />
          <span :title="agentName || agentId">{{ agentName || agentId }}</span>
          <select
            v-if="sessions.length > 1"
            v-model="selectedId"
            :aria-label="t('ui.browser-observer', '选择浏览器会话')"
            @change="selectedManually = true"
          >
            <option v-for="item in sessions" :key="item.id" :value="item.id">
              {{
                item.taskId
                  ? t('ui.browser-observer', '任务 {0}', [item.taskId])
                  : t('ui.browser-observer', '当前对话')
              }}
            </option>
          </select>
          <span v-else-if="selected.taskId">
            {{ t('ui.browser-observer', '任务 {0}', [selected.taskId]) }}
          </span>
        </div>
        <div class="browser-observer-screen" :class="{ 'is-paused': !live }">
          <img
            v-if="image"
            :src="image"
            :alt="t('ui.browser-observer', 'Agent 浏览器的只读画面')"
            draggable="false"
          />
          <span v-if="!live" class="browser-observer-overlay" role="status">
            <PixelIcon
              :name="frame.state === 'closed' ? 'globe' : 'clock'"
              size="lg"
              aria-hidden="true"
            />
            {{ status }}
          </span>
        </div>
        <footer>
          <span class="browser-observer-readonly" :class="{ 'is-live': live }">
            {{ t('ui.browser-observer', '只读') }}
          </span>
          <span class="browser-observer-page" :title="frame.url">{{ frame.title || frame.url }}</span>
          <div class="aux-controls">
            <button
              type="button"
              class="aux-button"
              :title="t('ui.browser-observer', '缩小小窗')"
              :aria-label="t('ui.browser-observer', '缩小小窗')"
              @click="scale(0.8)"
            >
              <PixelIcon name="minus" size="sm" aria-hidden="true" />
            </button>
            <button
              type="button"
              class="aux-button"
              :title="t('ui.browser-observer', '放大小窗')"
              :aria-label="t('ui.browser-observer', '放大小窗')"
              @click="scale(1.25)"
            >
              <PixelIcon name="plus" size="sm" aria-hidden="true" />
            </button>
          </div>
        </footer>
        <span
          v-for="direction in embedded ? [] : ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']"
          :key="direction"
          class="browser-observer-resize"
          :class="`resize-${direction}`"
          aria-hidden="true"
          @pointerdown="startGesture($event, direction)"
        />
      </section>
    </template>
  </Teleport>
</template>

<style scoped>
.browser-observer,
.browser-observer-dock {
  --aux-accent: var(--ui-accent-sky);
  position: fixed;
  z-index: 900;
  box-sizing: border-box;
  color: var(--ui-text-primary);
  background: var(--ui-bg-surface);
  border: 1px solid var(--ui-border-strong);
  box-shadow: var(--ui-shadow-lg);
  font: 12px/1.45 var(--ui-font-sans);
}
.browser-observer {
  display: flex;
  flex-direction: column;
}
.browser-observer-dock {
  display: inline-flex;
  align-items: center;
  right: 24px;
  bottom: 96px;
  padding-right: 2px;
}
.browser-observer-launcher {
  display: flex;
  align-items: center;
  gap: 9px;
  height: 34px;
  padding: 0 12px 0 0;
  border: 0;
  border-right: 1px solid var(--ui-border-subtle);
  background: transparent;
  color: var(--ui-text-primary);
  font: 600 12px var(--ui-font-sans);
  cursor: pointer;
}
.browser-observer-launcher:hover {
  background: var(--ui-bg-hover);
}
.browser-observer-launcher:focus-visible,
.browser-observer-source select:focus-visible {
  outline: 2px solid var(--aux-accent);
  outline-offset: -2px;
}
.browser-observer-header {
  cursor: grab;
  touch-action: none;
}
.browser-observer-header:active { cursor: grabbing; }
.browser-observer-source {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  min-height: 28px;
  padding: 0 10px;
  color: var(--ui-text-secondary);
}
.browser-observer-source span,
.browser-observer-page {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.browser-observer-source select,
.browser-observer-source span + span {
  margin-left: auto;
  max-width: 60%;
}
.browser-observer-source select {
  min-width: 0;
  padding: 2px 4px;
  border: 1px solid var(--ui-border-default);
  border-radius: 0;
  color: inherit;
  background: var(--ui-bg-surface-soft);
  font: inherit;
}
.browser-observer-screen {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background: var(--ui-bg-canvas);
  border-block: 1px solid var(--ui-border-subtle);
}
.browser-observer-screen img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  pointer-events: none;
  user-select: none;
}
.browser-observer-screen.is-paused img { opacity: .16; }
.browser-observer-overlay {
  position: absolute;
  inset: 0;
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 8px;
  padding: 8px;
  color: var(--ui-text-secondary);
  background: color-mix(in srgb, var(--ui-bg-canvas) 72%, transparent);
  text-align: center;
}
.browser-observer-overlay .pixel-icon { color: var(--aux-accent); }
footer {
  --aux-button-size: 26px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 4px 2px 10px;
}
.browser-observer:not(.is-embedded) footer { padding-inline-end: 12px; }
.browser-observer-readonly {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
  font-size: 11px;
  color: var(--ui-text-secondary);
}
.browser-observer-readonly::before {
  content: '';
  width: 5px;
  height: 5px;
  background: var(--ui-text-tertiary);
}
.browser-observer-readonly.is-live::before { background: var(--ui-success); }
.browser-observer-page {
  flex: 1;
  color: var(--ui-text-secondary);
}
.browser-observer.is-embedded,
.browser-observer-dock.is-embedded {
  position: relative;
  inset: auto;
  z-index: auto;
  max-width: 100%;
  box-shadow: none;
}
.is-embedded .browser-observer-header {
  touch-action: auto;
  cursor: default;
}
.browser-observer-resize {
  position: absolute;
  touch-action: none;
}
.resize-n,
.resize-s {
  left: 8px;
  right: 8px;
  height: 6px;
  cursor: ns-resize;
}
.resize-n {
  top: -3px;
}
.resize-s {
  bottom: -3px;
}
.resize-e,
.resize-w {
  top: 8px;
  bottom: 8px;
  width: 6px;
  cursor: ew-resize;
}
.resize-e {
  right: -3px;
}
.resize-w {
  left: -3px;
}
.resize-ne,
.resize-nw,
.resize-se,
.resize-sw {
  width: 12px;
  height: 12px;
}
.resize-ne {
  right: -3px;
  top: -3px;
  cursor: nesw-resize;
}
.resize-nw {
  left: -3px;
  top: -3px;
  cursor: nwse-resize;
}
.resize-se {
  right: -3px;
  bottom: -3px;
  cursor: nwse-resize;
}
.resize-se::after {
  content: '';
  position: absolute;
  right: 4px;
  bottom: 4px;
  width: 6px;
  height: 6px;
  border-right: 2px solid var(--ui-text-tertiary);
  border-bottom: 2px solid var(--ui-text-tertiary);
}
.resize-sw {
  left: -3px;
  bottom: -3px;
  cursor: nesw-resize;
}
</style>
