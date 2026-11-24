<script setup lang="ts">
import { t as __t } from '../i18n/index'

/**
 * DetachedPanelView — 桌面外壳面板窗口
 *
 * 主界面的功能页摘出后，在独立的无边框窗口中只渲染该页面和一条细标题栏
 * （页面名称、置顶、透明度、合回主窗口、关闭）。每个面板是独立的前端实例，
 * 数据都从服务端读取；主窗口提供给页面的上下文在这里提供等价的一份。
 *
 * @see .docs/P03_DESKTOP_SHELL.md 阶段 1
 * @module packages/frontend/src/views/DetachedPanelView
 */
import {
  computed,
  defineAsyncComponent,
  onMounted,
  onUnmounted,
  provide,
  ref,
  shallowRef,
  watch,
  type Component,
} from 'vue'
import { useRoute } from 'vue-router'
import { PANEL_OPACITY_MAX, PANEL_OPACITY_MIN, isDetachablePage } from '@infos/shared'
import { getTabLoader } from '../composables/main/tabRegistry'
import { confirmTabLeave, useMainNav } from '../composables/main/useMainNav'
import { useDetachedPanels } from '../composables/shell/useDetachedPanels'
import { createDashboardContext, DASHBOARD_CTX_KEY, useGateway } from '../composables/dashboard'
import { useCustomTheme } from '../composables/ui/useCustomTheme'
import { useAgentStore, useNotificationStore } from '../stores'
import { useTaskCenterStore } from '../stores/taskCenterStore'
import MainTabLoading from '../components/main/MainTabLoading.vue'
import { PDialog, PixelIcon } from '../components/pixel'
import '../assets/aux-window.css'

defineOptions({ name: 'DetachedPanelView' })

/** 不属于 Dashboard 主题作用域的独立页面（与 MainView 一致）。 */
const STANDALONE_PAGES = new Set(['workspace', 'stronghold'])
/** 需要占满高度、自行滚动的页面（与 MainView 一致）。 */
const FULL_HEIGHT_PAGES = new Set(['workspace', 'logs', 'terminal', 'social', 'stronghold', 'desktop_home'])

const route = useRoute()
// 面板窗口只承载一个页面，页面 ID 在窗口创建时确定。
const pageId = String(route.params.pageId ?? '')
const supported = isDetachablePage(pageId)

const { getPageLabel } = useMainNav()
const title = computed(() => getPageLabel(pageId))
watch(
  title,
  (value) => {
    document.title = `${value || 'infOS'} - PeroperoChat`
  },
  { immediate: true },
)

const loader = supported ? getTabLoader(pageId) : undefined
const pageComponent: Component | null = loader
  ? defineAsyncComponent({
      loader,
      loadingComponent: MainTabLoading,
      delay: 80,
      timeout: 30_000,
      suspensible: false,
    })
  : null

// ── 页面运行环境：与主窗口提供的上下文等价 ──

provide('infos:onboarding-active', ref(false))
provide('infos:main-surface-visible', shallowRef(true))
provide('infos:app-background-active', shallowRef(false))

const ctx = createDashboardContext(ref(pageId))
provide(DASHBOARD_CTX_KEY, ctx)
const {
  showConfirm,
  confirmTitle,
  confirmContent,
  confirmType,
  confirmIsPrompt,
  confirmPromptValue,
  confirmPromptPlaceholder,
  handleConfirm,
  handleCancel,
} = ctx

const agentStore = useAgentStore()
watch(
  () => agentStore.activeAgentId,
  (agentId) => {
    if (agentId) ctx.activeAgentId.value = agentId
  },
  { immediate: true },
)

// 任务中心等页面依赖 Gateway 推送增量更新。
const gateway = useGateway()
const taskCenterStore = useTaskCenterStore()
const unbindTasks = taskCenterStore.bindGateway(gateway)
void taskCenterStore.refreshActive()
onUnmounted(unbindTasks)

onMounted(() => {
  void useCustomTheme().start()
  if (!agentStore.agents.length) void agentStore.fetchAgents().catch(() => {})
})

// ── 标题栏 ──

const shell = useDetachedPanels()
const showControls = shell.enabled && supported
const notify = useNotificationStore()
const state = computed(() => shell.panel(pageId))
const alwaysOnTop = computed(() => state.value?.alwaysOnTop ?? false)
const opacity = ref(1)
watch(
  () => state.value?.opacity,
  (value) => {
    if (typeof value === 'number') opacity.value = value
  },
  { immediate: true },
)
const busy = ref(false)

async function run(action: () => Promise<void>): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    await action()
  } catch (cause) {
    notify.toast(
      __t('ui.desktop-shell', '面板操作失败：{0}', [
        cause instanceof Error ? cause.message : String(cause),
      ]),
      'error',
    )
  } finally {
    busy.value = false
  }
}

function toggleTop(): void {
  void run(() => shell.set(pageId, { alwaysOnTop: !alwaysOnTop.value }))
}

function changeOpacity(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  if (!Number.isFinite(value)) return
  opacity.value = value
  void shell.set(pageId, { opacity: value }).catch(() => {})
}

/** 合回与关闭前沿用页面已有的离开确认（例如未保存的世界书）。 */
async function attach(): Promise<void> {
  if (!(await confirmTabLeave())) return
  await run(() => shell.attach(pageId))
}

async function close(): Promise<void> {
  if (!(await confirmTabLeave())) return
  await run(() => shell.close(pageId))
}
</script>

<template>
  <div class="main-view-root detached-panel">
    <header class="aux-bar detached-panel__bar">
      <span class="aux-mark"><PixelIcon name="panels" size="sm" aria-hidden="true" /></span>
      <span class="aux-title" :title="title">{{ title }}</span>
      <div v-if="showControls" class="aux-controls">
        <button
          type="button"
          class="aux-button"
          :aria-pressed="alwaysOnTop"
          :title="
            alwaysOnTop ? __t('ui.desktop-shell', '取消置顶') : __t('ui.desktop-shell', '置顶')
          "
          :aria-label="
            alwaysOnTop ? __t('ui.desktop-shell', '取消置顶') : __t('ui.desktop-shell', '置顶')
          "
          :disabled="busy"
          @click="toggleTop"
        >
          <PixelIcon name="pin" size="sm" aria-hidden="true" />
        </button>
        <label
          class="detached-panel__opacity"
          :title="__t('ui.desktop-shell', '透明度 {0}%', [Math.round(opacity * 100)])"
        >
          <PixelIcon name="eye" size="xs" />
          <input
            type="range"
            :min="PANEL_OPACITY_MIN"
            :max="PANEL_OPACITY_MAX"
            step="0.05"
            :value="opacity"
            :aria-label="__t('ui.desktop-shell', '透明度')"
            @input="changeOpacity"
          />
        </label>
        <button
          type="button"
          class="aux-button"
          :title="__t('ui.desktop-shell', '合回主窗口')"
          :aria-label="__t('ui.desktop-shell', '合回主窗口')"
          :disabled="busy"
          @click="attach"
        >
          <PixelIcon name="minimize" size="sm" aria-hidden="true" />
        </button>
        <button
          type="button"
          class="aux-button aux-button--close"
          :title="__t('ui.desktop-shell', '关闭')"
          :aria-label="__t('ui.desktop-shell', '关闭')"
          :disabled="busy"
          @click="close"
        >
          <PixelIcon name="close" size="sm" aria-hidden="true" />
        </button>
      </div>
    </header>

    <main
      class="main-content detached-panel__content"
      :class="{ 'detached-panel__content--full': FULL_HEIGHT_PAGES.has(pageId) }"
    >
      <component
        :is="pageComponent"
        v-if="pageComponent"
        :data-dashboard-scope="STANDALONE_PAGES.has(pageId) ? undefined : ''"
        :class="[
          'main-tab-content',
          'detached-panel__page',
          { 'dashboard-tab-content': !STANDALONE_PAGES.has(pageId) },
        ]"
      />
      <div v-else class="detached-panel__unsupported" role="alert">
        <PixelIcon name="alert" size="lg" />
        <p>{{ __t('ui.desktop-shell', '这个页面不能在桌面面板中打开') }}</p>
      </div>
    </main>

    <!-- 页面使用的全局确认弹窗 -->
    <PDialog
      v-model="showConfirm"
      :title="confirmTitle"
      :message="confirmContent"
      :mode="confirmIsPrompt ? 'prompt' : 'confirm'"
      :confirm-variant="confirmType === 'error' ? 'danger' : 'primary'"
      :default-value="confirmPromptValue"
      :placeholder="confirmPromptPlaceholder"
      @confirm="handleConfirm"
      @cancel="handleCancel"
    />
  </div>
</template>

<style scoped>
.detached-panel {
  --aux-accent: var(--ui-accent-purple);
  position: relative;
  isolation: isolate;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: var(--ui-bg-canvas);
  color: var(--ui-text-primary);
  font-family: var(--ui-font-sans);
}

.detached-panel__bar {
  -webkit-app-region: drag;
}

.detached-panel__opacity {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 9px;
  margin-right: 3px;
  border-inline: 1px solid var(--ui-border-subtle);
  color: var(--ui-text-secondary);
}

.detached-panel__opacity input {
  width: 64px;
  accent-color: var(--aux-accent);
  cursor: pointer;
}

.detached-panel__content {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  background: var(--ui-bg-canvas);
}

.detached-panel__content--full {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.detached-panel__content--full > .detached-panel__page {
  flex: 1;
  min-height: 0;
}

.detached-panel__page {
  position: relative;
  z-index: 1;
}

.detached-panel__unsupported {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  height: 100%;
  padding: 32px;
  color: var(--ui-text-secondary);
  text-align: center;
}
</style>
