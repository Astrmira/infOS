<script setup lang="ts">
import { computed, useId } from 'vue'
import { t as __t } from '../../i18n/index'
import { resolveModelBrand } from '../../lib/modelBrands'
import BrandIcon from '../brands/BrandIcon.vue'
import BrandSelect from '../brands/BrandSelect.vue'
import { PButton, PInput, PixelIcon } from '../pixel'

const props = defineProps<{
  modelIds: string[]
  loading: boolean
  placeholder: string
  label?: string
  keepManualInput?: boolean
  brandInInput?: boolean
  invalid?: boolean
}>()
const model = defineModel<string>({ required: true })
const emit = defineEmits<{ refresh: [] }>()
const labelId = useId()
const options = computed(() =>
  props.modelIds.map((id) => ({ label: id, value: id, brand: resolveModelBrand(id) })),
)
</script>

<template>
  <div class="flex min-w-0 flex-col gap-1.5" role="group" :aria-labelledby="labelId">
    <div class="flex items-center justify-between gap-2">
      <span
        :id="labelId"
        class="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-[var(--ui-text-secondary)] font-pixel"
      >
        <BrandIcon v-if="!brandInInput" :brand="resolveModelBrand(model)" size="xs" />
        {{ label ?? __t('ui.settings', '模型 ID') }}
      </span>
      <PButton variant="ghost" size="sm" :loading="loading" @click="emit('refresh')">
        <PixelIcon name="refresh" size="xs" />
        {{ __t('ui.settings', '获取模型列表') }}
      </PButton>
    </div>
    <BrandSelect
      v-if="options.length"
      :model-value="model"
      :options="options"
      :placeholder="__t('ui.settings', '从列表中选择...')"
      @update:model-value="model = String($event)"
    />
    <div v-if="keepManualInput || !options.length" class="flex min-w-0 items-center gap-2">
      <BrandIcon v-if="brandInInput" :brand="resolveModelBrand(model)" size="sm" />
      <PInput
        v-model="model"
        class="flex-1"
        :aria-labelledby="labelId"
        :aria-invalid="invalid || undefined"
        :placeholder="placeholder"
      />
    </div>
  </div>
</template>
