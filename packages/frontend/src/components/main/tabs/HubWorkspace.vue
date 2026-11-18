<script lang="ts">
export interface HubTab<Id extends string> {
  id: Id
  label: string
  icon: string
  detachPageId?: string
}
</script>

<script setup lang="ts" generic="TabId extends string">
import { ref } from 'vue'
import { t as __t } from '../../../i18n/index'
import { confirmTabLeave } from '../../../composables/main/useMainNav'
import { redirectTabRequest, useDetachedPanels } from '../../../composables/shell/useDetachedPanels'
import { PixelIcon } from '../../pixel'
import NavDetachMenu from '../../shell/NavDetachMenu.vue'

defineProps<{
  title: string
  icon: string
  navigationLabel: string
  tabs: HubTab<TabId>[]
  fullHeight?: boolean
}>()
const selected = defineModel<TabId>({ required: true })
const shell = useDetachedPanels()
const detachMenu = ref<InstanceType<typeof NavDetachMenu> | null>(null)

async function selectTab(tab: HubTab<TabId>) {
  if (tab.detachPageId && redirectTabRequest(tab.detachPageId)) return
  if (selected.value === tab.id || !(await confirmTabLeave())) return
  selected.value = tab.id
}
</script>

<template>
  <div class="hub-workspace">
    <header v-if="tabs.length > 1" class="hub-header">
      <div class="hub-brand">
        <PixelIcon :name="icon" size="sm" class="hub-brand-icon" />
        <h1 class="hub-brand-title">{{ title }}</h1>
      </div>

      <nav class="hub-tabs" :aria-label="navigationLabel">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          type="button"
          class="hub-tab-btn"
          :class="{ 'is-active': selected === tab.id }"
          :aria-current="selected === tab.id ? 'page' : undefined"
          :data-onboarding-nav="tab.detachPageId ?? tab.id"
          @click="selectTab(tab)"
          @contextmenu="tab.detachPageId && detachMenu?.open($event, tab.detachPageId)"
        >
          <PixelIcon :name="tab.icon" size="xs" />
          <span>{{ tab.label }}</span>
          <PixelIcon
            v-if="tab.detachPageId && shell.isDetached(tab.detachPageId)"
            name="external-link"
            size="xs"
            class="hub-tab-detached"
            :title="__t('ui.desktop-shell', '已摘出到桌面')"
          />
        </button>
      </nav>
    </header>

    <div class="hub-stage settings-scrollbar" :class="{ 'hub-stage--full': fullHeight }">
      <slot />
    </div>
    <NavDetachMenu ref="detachMenu" />
  </div>
</template>

<style scoped src="./hub-workspace.css"></style>
