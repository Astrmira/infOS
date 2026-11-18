<script setup lang="ts">
import { computed, defineAsyncComponent } from 'vue'
import { t as __t } from '../../../i18n/index'
import { useMainNav, type MemorySubTab } from '../../../composables/main/useMainNav'
import HubWorkspace, { type HubTab } from './HubWorkspace.vue'
import MainTabLoading from '../MainTabLoading.vue'
import MemoriesTab from '../../dashboard/tabs/MemoriesTab.vue'

/**
 * MemoryHubTab — 记忆馆聚合工作台
 *
 * 统一承载「核心记忆」「知识库」「对话日志」，
 * 默认首屏子页同步引入避免二次异步瀑布流，其他分区按需加载。
 */
defineOptions({ name: 'MemoryHubTab' })

const KnowledgeTab = defineAsyncComponent({
  loader: () => import('../../dashboard/tabs/KnowledgeTab.vue'),
  loadingComponent: MainTabLoading,
  delay: 80,
  suspensible: false,
})

const LogsTab = defineAsyncComponent({
  loader: () => import('../../dashboard/tabs/LogsTab.vue'),
  loadingComponent: MainTabLoading,
  delay: 80,
  suspensible: false,
})

const { memorySubTab } = useMainNav()

const tabs = computed<HubTab<MemorySubTab>[]>(() => [
  {
    id: 'memories',
    label: __t('ui.navigation', '核心记忆'),
    icon: 'brain',
    detachPageId: 'memories',
  },
  {
    id: 'knowledge',
    label: __t('ui.navigation', '知识库'),
    icon: 'database',
    detachPageId: 'knowledge',
  },
  {
    id: 'logs',
    label: __t('ui.navigation', '对话日志'),
    icon: 'chat',
    detachPageId: 'logs',
  },
])
</script>

<template>
  <HubWorkspace
    v-model="memorySubTab"
    icon="brain"
    :title="__t('ui.navigation', '记忆馆')"
    :navigation-label="__t('ui.navigation', '记忆馆分区')"
    :tabs="tabs"
    :full-height="memorySubTab === 'logs'"
  >
    <MemoriesTab v-if="memorySubTab === 'memories'" />
    <KnowledgeTab v-else-if="memorySubTab === 'knowledge'" />
    <LogsTab v-else-if="memorySubTab === 'logs'" />
  </HubWorkspace>
</template>
