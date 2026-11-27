<script setup lang="ts">
import { t as __t } from '../../i18n/index'

import { computed, ref, onMounted, watch } from 'vue'
import type {
  DesktopModelEntry,
  DesktopModelScan,
  DesktopModelScanIssue,
} from '@infos/avatar-assets'
import type BedrockAvatar from '../avatar/BedrockAvatar.vue'
import PetModelOption from './PetModelOption.vue'
import PetHudIcon from './PetHudIcon.vue'
import type { AvatarQuality } from '../avatar/lib/avatarPerformance'
import { invoke } from '../../utils/ipcAdapter'
import {
  AVATAR_MODEL_STORAGE_KEY,
  DEFAULT_AVATAR_MANIFEST_PATH,
  DEFAULT_AVATAR_NAME,
} from '../avatar/lib/avatarDefaults'
const props = defineProps<{ avatarRef?: InstanceType<typeof BedrockAvatar> | null }>()
const qualityOptions: Array<{ value: AvatarQuality; label: string }> = [
  {
    value: 'economy',
    get label() {
      return __t('ui.pet', '节能')
    },
  },
  {
    value: 'balanced',
    get label() {
      return __t('ui.pet', '均衡')
    },
  },
  {
    value: 'high',
    get label() {
      return __t('ui.pet', '精细')
    },
  },
]
const emit = defineEmits<{
  (e: 'model-change', path: string, complete: (success: boolean, message?: string) => void): void
}>()
const avatarClothingState = computed(() => {
  return props.avatarRef?.clothingState ?? {}
})

const avatarFeatureButtons = computed(() => {
  return props.avatarRef?.featureButtons ?? []
})

const avatarAnimList = computed(() => {
  return props.avatarRef?.animList ?? []
})
const view = ref<'models' | 'actions'>('models')
const tabs = computed(() => [
  {
    id: 'models' as const,
    get label() {
      return __t('ui.pet', '换个样子')
    },
  },
  ...(avatarAnimList.value.length
    ? [
        {
          id: 'actions' as const,
          get label() {
            return __t('ui.pet', '动作小剧场')
          },
        },
      ]
    : []),
])
watch(
  tabs,
  (available) => {
    if (!available.some((tab) => tab.id === view.value)) view.value = available[0]!.id
  },
  { immediate: true },
)
function animationIcon(name: string) {
  if (/wave|挥手|招手/i.test(name)) return 'wave'
  if (/sit|坐/i.test(name)) return 'heart'
  return 'sparkle'
}

function setAvatarAnimation(animName: string) {
  const av = props.avatarRef
  if (av && typeof av.setAnimation === 'function') {
    av.setAnimation(animName)
  }
}

function updateAvatarClothing() {
  const av = props.avatarRef
  if (av && typeof av.updateClothing === 'function') {
    av.updateClothing()
  }
}

/** 显式切换单个服装部件开关：优先走组件暴露的 setter，确保写入模型状态并持久化。 */
function toggleClothingPart(id: string, checked: boolean): void {
  const av = props.avatarRef
  const setter = av?.setClothingPart
  if (typeof setter === 'function') {
    setter(id, checked)
    return
  }
  // 兜底：直接写暴露的响应式状态，再手动应用。
  const state = av?.clothingState
  if (state) state[id] = checked
  updateAvatarClothing()
}

// ── 角色选择网格 (v1: scan-3d-models IPC) ──
const availableModels = ref<DesktopModelEntry[]>([])
const scanIssues = ref<DesktopModelScanIssue[]>([])
function describeScanIssue({ entry, reason }: DesktopModelScanIssue): string {
  switch (reason) {
    case 'zip':
      return __t('ui.pet', '请先解压 {0}，把含入口文件的模型文件夹放进 models。', [entry])
    case 'ysm-file':
      return __t('ui.pet', '{0} 是单文件 YSM，请使用含 ysm.json 的目录版。', [entry])
    case 'missing-entry':
      return __t('ui.pet', '{0} 缺少入口文件，请检查 manifest.json 或 ysm.json 的层级。', [entry])
    case 'invalid-entry':
      return __t('ui.pet', '无法读取 {0} 的模型，请检查清单、几何与贴图路径。', [entry])
    case 'unreadable':
      return __t('ui.pet', '无法扫描模型目录 {0}。', [entry])
  }
}
const currentModelName = ref(DEFAULT_AVATAR_NAME)
const switchingModelName = ref('')
const isLoadingModels = ref(false)
const modelSwitchError = ref('')

async function openModelFolder() {
  try {
    await invoke('open-client-path', 'models')
  } catch {
    modelSwitchError.value = __t('ui.pet', '打开模型目录失败。')
  }
}

/** 扫描可用 3D 模型 */
async function scanModels() {
  if (isLoadingModels.value) return
  isLoadingModels.value = true
  try {
    const report = (await invoke('scan-3d-models', { includeIssues: true })) as
      | DesktopModelScan
      | DesktopModelEntry[]
      | null
    if (!report) return
    const models = Array.isArray(report) ? report : report.models
    scanIssues.value = Array.isArray(report) ? [] : report.issues
    availableModels.value = models
    const selectedPath =
      localStorage.getItem(AVATAR_MODEL_STORAGE_KEY) || DEFAULT_AVATAR_MANIFEST_PATH
    const selectedModel = models.find((model) => model.path === selectedPath)
    currentModelName.value = selectedModel?.name || DEFAULT_AVATAR_NAME
    modelSwitchError.value = ''
  } catch {
    modelSwitchError.value = __t('ui.pet', '模型列表扫描失败，请刷新重试。')
  } finally {
    isLoadingModels.value = false
  }
}

/** 选择模型 */
function selectModel(model: DesktopModelEntry) {
  if (switchingModelName.value) return

  // scan-3d-models 已返回可直接 fetch 的最终入口 URL，无需再次绕行 IPC。
  const loadPath = model.path

  modelSwitchError.value = ''
  switchingModelName.value = model.name
  emit('model-change', loadPath, (success, message) => {
    switchingModelName.value = ''
    if (!success) {
      modelSwitchError.value = message || __t('ui.avatar', '模型加载失败')
      return
    }

    currentModelName.value = model.name
    localStorage.setItem(AVATAR_MODEL_STORAGE_KEY, loadPath)
  })
}

onMounted(scanModels)
</script>

<template>
  <div class="appearance">
    <div class="section-heading">
      <div class="appearance-tabs" :aria-label="__t('ui.pet', '互动内容')">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          type="button"
          :aria-pressed="view === tab.id"
          @click="view = tab.id"
        >
          {{ tab.label }}
        </button>
      </div>
      <button v-if="view === 'models'" type="button" @click="openModelFolder">
        {{ __t('ui.pet', '模型目录') }}
      </button>
      <button
        v-if="view === 'models'"
        type="button"
        :disabled="isLoadingModels"
        @click="scanModels"
      >
        {{ isLoadingModels ? __t('ui.pet', '读取中…') : __t('ui.pet', '刷新') }}
      </button>
    </div>
    <div :key="view" class="appearance-view">
      <template v-if="view === 'models'">
        <div class="model-grid">
          <PetModelOption
            v-for="model in availableModels"
            :key="model.path"
            :name="model.name"
            :thumbnail="model.thumbnail"
            :selected="model.name === currentModelName"
            :loading="model.name === switchingModelName"
            :disabled="!!switchingModelName"
            @select="selectModel(model)"
          />
        </div>
        <p v-if="!isLoadingModels && !availableModels.length" class="muted">
          {{ __t('ui.pet', '还没有其他造型') }}
        </p>
        <p v-if="modelSwitchError" class="error" role="alert">{{ modelSwitchError }}</p>
        <p v-for="issue in scanIssues" :key="issue.entry" class="error">
          {{ describeScanIssue(issue) }}
        </p>
        <div class="clothing-details">
          <h4>{{ __t('ui.pet', '画质') }}</h4>
          <div class="choices" :aria-label="__t('ui.pet', '桌宠画质')">
            <button
              v-for="option in qualityOptions"
              :key="option.value"
              type="button"
              :aria-pressed="(avatarRef?.quality ?? 'balanced') === option.value"
              :class="{ selected: (avatarRef?.quality ?? 'balanced') === option.value }"
              @click="avatarRef?.setQuality(option.value)"
            >
              {{ option.label }}
            </button>
          </div>
        </div>
        <div v-if="avatarFeatureButtons.length" class="clothing-details">
          <h4>{{ __t('ui.pet', '穿搭细节') }}</h4>
          <div class="choices">
            <button
              v-for="part in avatarFeatureButtons"
              :key="part.id"
              type="button"
              :aria-pressed="!!avatarClothingState[part.id]"
              :class="{ selected: avatarClothingState[part.id] }"
              @click="toggleClothingPart(part.id, !avatarClothingState[part.id])"
            >
              {{ part.label }}
            </button>
          </div>
        </div>
      </template>
      <template v-else>
        <div class="animation-choices">
          <button
            v-for="animation in avatarAnimList"
            :key="animation"
            type="button"
            @click="setAvatarAnimation(animation)"
          >
            <PetHudIcon :name="animationIcon(animation)" size="lg" />
            {{ animation }}
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped src="./pet-appearance.css" />
