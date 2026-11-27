/** 头像资产适配包公共入口。 */
export interface DesktopModelEntry {
  name: string
  path: string
  thumbnail?: string
}

export interface DesktopModelScanIssue {
  entry: string
  reason: 'zip' | 'ysm-file' | 'missing-entry' | 'invalid-entry' | 'unreadable'
}

export interface DesktopModelScan {
  models: DesktopModelEntry[]
  issues: DesktopModelScanIssue[]
}

export {
  BASE_HEIGHT,
  BONE_ALIASES,
  YSM_SCENE_FILTERS,
  YsmManifestGenerator,
} from './YsmManifestGenerator'
export type {
  MappingHealth,
  YsmConfig,
  YsmConfigForm,
  YsmExtraButton,
  YsmFeatureButton,
  YsmGeneratedManifest,
  YsmTextureItem,
} from './YsmManifestGenerator'
