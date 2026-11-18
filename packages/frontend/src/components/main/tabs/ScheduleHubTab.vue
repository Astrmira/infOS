<script setup lang="ts">
import { computed, defineAsyncComponent, watchEffect } from 'vue'
import { t as __t } from '../../../i18n/index'
import { isElectron } from '../../../utils/ipcAdapter'
import { useMainNav, type ScheduleSubTab } from '../../../composables/main/useMainNav'
import HubWorkspace, { type HubTab } from './HubWorkspace.vue'
import MainTabLoading from '../MainTabLoading.vue'

/**
 * ScheduleHubTab — 日程聚合工作台
 *
 * 统一承载「任务中心」与「桌面卡片（仅 Electron）」，非激活视图即时卸载。
 */
defineOptions({ name: 'ScheduleHubTab' })

const TasksTab = defineAsyncComponent({
  loader: () => import('../../dashboard/tabs/TasksTab.vue'),
  loadingComponent: MainTabLoading,
  delay: 80,
  suspensible: false,
})

const CardsTab = defineAsyncComponent({
  loader: () => import('../../shell/cards/CardsTab.vue'),
  loadingComponent: MainTabLoading,
  delay: 80,
  suspensible: false,
})

const desktop = isElectron()
const { scheduleSubTab } = useMainNav()

watchEffect(() => {
  if (!desktop && scheduleSubTab.value === 'cards') {
    scheduleSubTab.value = 'tasks'
  }
})

const tabs = computed<HubTab<ScheduleSubTab>[]>(() => [
  {
    id: 'tasks',
    label: __t('ui.navigation', '任务中心'),
    icon: 'bell',
    detachPageId: 'tasks',
  },
  ...(desktop
    ? [
        {
          id: 'cards' as const,
          label: __t('ui.navigation', '桌面卡片'),
          icon: 'layout',
          detachPageId: 'cards',
        },
      ]
    : []),
])
</script>

<template>
  <HubWorkspace
    v-model="scheduleSubTab"
    icon="calendar"
    :title="__t('ui.navigation', '日程')"
    :navigation-label="__t('ui.navigation', '日程分区')"
    :tabs="tabs"
  >
    <TasksTab v-if="scheduleSubTab === 'tasks'" />
    <CardsTab v-else-if="desktop && scheduleSubTab === 'cards'" />
  </HubWorkspace>
</template>
