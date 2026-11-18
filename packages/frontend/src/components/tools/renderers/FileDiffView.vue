<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { VirtualizedFileDiff, Virtualizer } from '@pierre/diffs'
import { t } from '../../../i18n'
import { fileDiffPatches } from '../../../lib/fileDiffPatch'
import type { FileDiffRow } from '../../../lib/fileMutationDiff'

const props = defineProps<{ rows: FileDiffRow[]; path: string; active: boolean }>()
const emit = defineEmits<{ scroll: [] }>()
const viewport = ref<HTMLElement | null>(null)
const content = ref<HTMLElement | null>(null)
const ready = ref(false)
const instances: Array<{ view: VirtualizedFileDiff; element: HTMLElement }> = []
let virtualizer: Virtualizer | undefined
let generation = 0
let disposed = false
const themeType = () => document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'

// 自定义 CSS 只引用本应用的主题变量，文件内容始终交给代码渲染器转义。
const unsafeCSS = `
  :host {
    --diffs-font-family: var(--ui-font-mono);
    --diffs-font-size: 11px;
    --diffs-line-height: 22px;
    --diffs-bg: var(--ui-bg-surface);
    --diffs-fg: var(--ui-text-primary);
    --diffs-fg-number: var(--ui-text-tertiary);
    --diffs-addition-base: var(--ui-success);
    --diffs-deletion-base: var(--ui-danger);
  }
  [data-code] { border-radius: 0; }
`

function release(): void {
  for (const instance of instances) instance.view.cleanUp()
  instances.length = 0
  virtualizer?.cleanUp()
  virtualizer = undefined
  content.value?.replaceChildren()
  ready.value = false
}

watch([() => props.rows, () => props.path, () => props.active, content], async () => {
  const request = ++generation
  if (!props.active || !props.rows.length || !viewport.value || !content.value) {
    release()
    return
  }
  if (
    typeof customElements === 'undefined' || typeof CSSStyleSheet === 'undefined' ||
    typeof CSSStyleSheet.prototype.replaceSync !== 'function' ||
    typeof ShadowRoot === 'undefined' || !('adoptedStyleSheets' in ShadowRoot.prototype)
  ) {
    release()
    return
  }
  const patches = fileDiffPatches(props.rows, props.path)
  if (!patches?.length) {
    release()
    return
  }
  try {
    const module = await import('@pierre/diffs')
    if (disposed || request !== generation || !viewport.value || !content.value) return
    const files = patches.map((patch) => module.parsePatchFiles(patch, {
      disableLineMatching: true,
      throwOnError: true,
    })[0]?.files[0])
    if (files.some((file) => !file)) {
      release()
      return
    }
    if (!virtualizer) {
      virtualizer = new module.Virtualizer()
      virtualizer.setup(viewport.value, content.value)
    }
    while (instances.length > files.length) instances.pop()!.view.cleanUp()
    for (const [index, file] of files.entries()) {
      let instance = instances[index]
      if (!instance) {
        const element = document.createElement('diffs-container')
        content.value.appendChild(element)
        instance = {
          element,
          view: new module.VirtualizedFileDiff({
            diffStyle: 'unified',
            theme: { light: 'pierre-light', dark: 'pierre-dark' },
            themeType: themeType(),
            disableFileHeader: true,
            disableErrorHandling: true,
            hunkSeparators: 'metadata',
            diffIndicators: 'classic',
            overflow: 'scroll',
            lineDiffType: 'none',
            unsafeCSS,
          }, virtualizer, { lineHeight: 22, diffHeaderHeight: 0 }),
        }
        instances.push(instance)
      }
      instance.view.render({ fileContainer: instance.element, fileDiff: file! })
    }
    ready.value = true
  } catch {
    // 按需模块或补丁解析不可用时，由插槽继续承载已有差异行。
    if (request === generation) release()
  }
}, { immediate: true, flush: 'post' })

const themeObserver = new MutationObserver(() => {
  for (const instance of instances) instance.view.setThemeType(themeType())
})
themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
onBeforeUnmount(() => {
  disposed = true
  generation++
  themeObserver.disconnect()
  release()
})
defineExpose({ viewport: computed(() => ready.value ? viewport.value : null) })
</script>

<template>
  <div class="file-diff-view">
    <div
      ref="viewport"
      class="file-diff-view__viewport"
      :class="{ 'is-preparing': !ready }"
      :aria-hidden="!ready || undefined"
      :aria-label="t('ui.tools', '文件差异')"
      tabindex="0"
      @scroll.passive="emit('scroll')"
    >
      <div ref="content" />
    </div>
    <slot v-if="!ready" />
  </div>
</template>

<style scoped>
.file-diff-view {
  position: relative;
  min-width: 0;
}
.file-diff-view__viewport {
  max-height: 300px;
  overflow: auto;
  overflow-anchor: none;
  overscroll-behavior: contain;
}
.file-diff-view__viewport.is-preparing {
  position: absolute;
  inset: 0;
  visibility: hidden;
  pointer-events: none;
}
</style>
