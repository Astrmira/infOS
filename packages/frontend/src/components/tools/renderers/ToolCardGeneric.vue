<script setup lang="ts">
import { computed } from 'vue'
import { t as __t } from '../../../i18n/index'
import type { ToolCardRendererProps } from '../toolRenderers'

const props = defineProps<ToolCardRendererProps>()

// 长日志与大集合直接展示原文，避免流式更新反复解析或挂载大量字段。
function fieldsOf(raw?: string) {
  if (!raw || raw.length > 64 * 1024 || !/^\s*[\[{]/.test(raw)) return
  try {
    const value = JSON.parse(raw, (_key, item: unknown) => {
      if (typeof item !== 'number') return item
      if (!Number.isFinite(item) || (Number.isInteger(item) && !Number.isSafeInteger(item))) {
        throw new RangeError()
      }
      return item
    })
    const entries = Object.entries(value)
    if (!entries.length || entries.length > 64) return
    return entries.map(([key, item]) => ({
      key: Array.isArray(value) ? `[${key}]` : key,
      value: typeof item === 'string' && item.length ? item : JSON.stringify(item),
    }))
  } catch {
    // 流式片段、非标准 JSON 和无法精确表示的数值保留原文。
    return
  }
}

const argumentFields = computed(() => fieldsOf(props.args))
const resultFields = computed(() => fieldsOf(props.result))
const sections = computed(() => [
  {
    id: 'IN',
    label: __t('ui.tools', '调用参数'),
    raw: props.args || undefined,
    fields: argumentFields.value,
  },
  {
    id: 'OUT',
    label: props.isError ? __t('ui.tools', '异常输出') : __t('ui.tools', '返回结果'),
    raw: props.result,
    fields: resultFields.value,
    error: props.isError,
  },
])
</script>

<template>
  <section class="generic-inspector">
    <template v-for="section in sections" :key="section.id">
      <div
        v-if="section.raw !== undefined"
        class="generic-section"
        :class="{ 'is-error': section.error }"
      >
        <header>
          <b aria-hidden="true">{{ section.id }}</b>
          <span>{{ section.label }}</span>
        </header>
        <dl v-if="section.fields" class="generic-fields">
          <div v-for="field in section.fields" :key="field.key">
            <dt>{{ field.key || '""' }}</dt>
            <dd>{{ field.value }}</dd>
          </div>
        </dl>
        <pre v-else>{{ section.raw }}</pre>
      </div>
    </template>
  </section>
</template>

<style scoped>
.generic-inspector {
  display: grid;
  background: transparent;
}
.generic-section + .generic-section {
  border-top: 1px solid var(--ui-border-subtle);
}
.generic-section header {
  display: grid;
  min-height: 28px;
  grid-template-columns: 44px minmax(0, 1fr);
  border-bottom: 1px solid var(--ui-border-subtle);
  background: var(--traj-compartment, var(--ui-bg-surface-soft));
}
.generic-section header b {
  display: grid;
  place-items: center;
  border-right: 1px solid var(--ui-border-default);
  color: var(--tc-accent, var(--ui-accent-purple));
  font: 700 9.5px var(--ui-font-mono);
}
.generic-section header span {
  padding: 0 10px;
  color: var(--ui-text-tertiary);
  font: 600 10.5px/28px var(--ui-font-sans);
}
.generic-section pre {
  max-height: 220px;
  margin: 0;
  overflow: auto;
  padding: 9px 12px 9px 54px;
  background: linear-gradient(
    90deg,
    var(--ui-bg-surface-soft) 43px,
    var(--ui-border-subtle) 44px,
    transparent 45px
  );
  color: var(--ui-text-secondary);
  font: 11px/1.6 var(--ui-font-mono);
  white-space: pre-wrap;
  word-break: break-all;
}
.generic-fields {
  max-height: 220px;
  margin: 0;
  overflow: auto;
  font: 11px/1.6 var(--ui-font-mono);
}
.generic-fields > div {
  display: grid;
  grid-template-columns: minmax(0, 30%) minmax(0, 1fr);
  border-bottom: 1px solid var(--ui-border-subtle);
}
.generic-fields dt,
.generic-fields dd {
  margin: 0;
  padding: 4px 10px;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.generic-fields dt {
  background: var(--ui-bg-surface-soft);
  color: var(--ui-text-secondary);
}
.generic-fields dd {
  color: var(--ui-text-primary);
}
.generic-section.is-error {
  border-top: 2px solid var(--ui-danger);
}
.generic-section.is-error header b,
.generic-section.is-error dd,
.generic-section.is-error pre {
  color: var(--ui-danger);
}
.generic-section.is-error pre {
  background-color: var(--ui-danger-soft);
}
</style>
