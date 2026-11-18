<script setup lang="ts">
import { t as __t } from '../../../i18n/index'

/**
 * McpPanel — MCP 服务管理面板
 *
 * 接收 useMcpConfig 提供的数据，渲染 MCP 服务列表、操作按钮。
 * 由 McpTab 组件编排使用。
 */
import { PixelIcon, PBadge, PButton, PCard, PEmpty } from '../../pixel'
import MotionList from '../../motion/MotionList.vue'
import MotionSkeleton from '../../motion/MotionSkeleton.vue'
import type { McpServerView } from '../../../composables/dashboard/useMcpConfig'

/** MCP 未声明用户标题时，将协议工具标识转换为可读名称。 */
function toolLabel(name: string): string {
  return name
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

defineProps<{
  servers: McpServerView[]
  isLoading: boolean
  expandedId: number | null
}>()

const emit = defineEmits<{
  (e: 'toggle-expand', id: number): void
  (e: 'toggle-enabled', id: number): void
  (e: 'reconnect', id: number): void
  (e: 'remove', id: number): void
}>()

const statusBadges = {
  connected: { label: '已连接', variant: 'success', dot: 'bg-[var(--ui-success)]' },
  disconnected: { label: '未连接', variant: 'default', dot: 'bg-[var(--ui-text-disabled)]' },
  error: { label: '错误', variant: 'danger', dot: 'bg-[var(--ui-danger)]' },
  unknown: { label: '未知', variant: 'default', dot: 'bg-[var(--ui-text-disabled)]' },
} as const satisfies Record<McpServerView['status'], unknown>

function statusBadge(status: McpServerView['status']) {
  return statusBadges[status] ?? statusBadges.unknown
}
</script>

<template>
  <!-- 加载状态 -->
  <MotionSkeleton
    v-if="isLoading && servers.length === 0"
    class="flex-1"
    variant="card"
    :rows="3"
    :label="__t('ui.settings', '正在加载 MCP 配置...')"
  />

  <!-- 空状态 -->
  <div v-else-if="servers.length === 0" class="flex-1 flex items-center justify-center">
    <PEmpty :description="__t('ui.settings', '还没有配置 MCP 服务')" />
  </div>

  <!-- 服务列表 -->
  <MotionList v-else class="flex-1 overflow-y-auto flex flex-col gap-2 mcp-scrollbar">
    <PCard
      v-for="srv in servers"
      :key="srv.id"
      pixel
      hoverable
      padding="sm"
      class="cursor-pointer"
      @click="emit('toggle-expand', srv.id)"
    >
      <div class="flex items-center gap-3">
        <div :class="['w-2 h-2 flex-shrink-0 rounded-full', statusBadge(srv.status).dot]" />
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <h4 class="text-sm font-black text-[var(--ui-text-primary)]">{{ srv.name }}</h4>
            <PBadge size="sm" :variant="statusBadge(srv.status).variant">
              {{ __t('ui.settings', statusBadge(srv.status).label) }}
            </PBadge>
            <PBadge size="sm">{{ (srv.type ?? 'stdio').toUpperCase() }}</PBadge>
            <PBadge v-if="!srv.enabled" size="sm" variant="warning">
              {{ __t('ui.settings', '已禁用') }}
            </PBadge>
          </div>
          <p class="text-[11px] text-[var(--ui-text-tertiary)] font-mono mt-1 truncate">
            {{ srv.type === 'stdio' ? srv.command : srv.url }}
            <span v-if="srv.args && srv.args.length > 0" class="ml-1 text-[var(--ui-text-tertiary)]">
              {{ srv.args.join(' ') }}
            </span>
          </p>
          <p v-if="srv.error" class="text-[11px] text-[var(--ui-danger)] font-mono mt-1 truncate">
            ⚠ {{ srv.error }}
          </p>
        </div>
        <div class="flex gap-1 flex-shrink-0">
          <PButton
            variant="ghost"
            size="sm"
            :title="__t('ui.settings', '切换启用/禁用')"
            @click.stop="emit('toggle-enabled', srv.id)"
          >
            <PixelIcon name="eye" size="xs" />
          </PButton>
          <PButton
            variant="ghost"
            size="sm"
            :title="__t('ui.settings', '重新连接')"
            :disabled="!srv.enabled"
            @click.stop="emit('reconnect', srv.id)"
          >
            <PixelIcon name="refresh" size="xs" />
          </PButton>
          <PButton
            variant="ghost"
            size="sm"
            :title="__t('ui.settings', '删除')"
            @click.stop="emit('remove', srv.id)"
          >
            <PixelIcon name="trash" size="xs" />
          </PButton>
        </div>
      </div>

      <!-- 工具列表 (展开) -->
      <div
        v-if="expandedId === srv.id && srv.tools.length > 0"
        class="mt-3 pt-3 border-t border-[var(--ui-border-subtle)]"
      >
        <h5 class="text-[10px] font-bold uppercase tracking-wider text-[var(--ui-text-secondary)] mb-2 font-pixel">
          {{ __t('ui.settings', '可用工具 (') }}{{ srv.tools.length }})
        </h5>
        <div
          v-for="tool in srv.tools"
          :key="tool.name"
          class="flex justify-between items-center px-2 py-1.5 border border-[color:var(--ui-border-default)] mb-1"
        >
          <span class="text-xs font-bold text-[var(--ui-accent-sky)]">{{ toolLabel(tool.name) }}</span>
          <span class="text-[11px] text-[var(--ui-text-tertiary)] truncate ml-3">{{ tool.description }}</span>
        </div>
      </div>

      <!-- 无工具提示 -->
      <div
        v-if="expandedId === srv.id && srv.tools.length === 0 && srv.status === 'connected'"
        class="mt-3 pt-3 border-t border-[color:var(--ui-border-subtle)]"
      >
        <p class="text-[11px] text-[var(--ui-text-tertiary)] italic">
          {{ __t('ui.settings', '该服务未暴露任何工具') }}
        </p>
      </div>
    </PCard>
  </MotionList>
</template>
