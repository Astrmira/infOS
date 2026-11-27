import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({ paths: { models: '', resources: '' }, isDev: false }))
vi.mock('../utils/env', () => env)
vi.mock('./steam', () => ({ getWorkshopInstallations: () => [] }))
vi.mock('../utils/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }))
vi.mock('electron', () => ({ app: { getAppPath: () => env.paths.resources } }))
import { scan3DModels } from './assets'

it('扫描目录版 YSM 时隔离坏清单，并报告需要处理的压缩包、单文件和多余目录层级', async () => {
  const data = process.env.PERO_DATA_DIR!
  env.paths.models = path.join(data, 'models')
  env.paths.resources = path.join(data, 'resources')
  const local = env.paths.models
  for (const name of ['A-invalid', 'B-valid', 'C-wrapper/inner']) {
    mkdirSync(path.join(local, name), { recursive: true })
  }
  writeFileSync(path.join(local, 'A-invalid/manifest.json'), '{')
  writeFileSync(path.join(local, 'C-wrapper/inner/ysm.json'), '{}')
  writeFileSync(path.join(local, 'model.ysm'), 'ysm')
  writeFileSync(path.join(local, 'model.zip'), 'zip')
  writeFileSync(
    path.join(local, 'B-valid/ysm.json'),
    JSON.stringify({
      metadata: { name: '测试桌宠' },
      files: { player: { model: { main: 'models/main.json' }, texture: ['textures/body.png'] } },
    }),
  )

  const { models, issues } = await scan3DModels()
  expect(issues).toHaveLength(4)
  expect(issues).toEqual(
    expect.arrayContaining([
      { entry: 'A-invalid', reason: 'invalid-entry' },
      { entry: 'model.ysm', reason: 'ysm-file' },
      { entry: 'model.zip', reason: 'zip' },
      { entry: 'C-wrapper', reason: 'missing-entry' },
    ]),
  )
  expect(models.map((model) => model.name)).toEqual(['测试桌宠'])
  const base = new URL('.', models[0]!.path).href
  expect(new URL(base).host).toBe('model')
  expect(models[0]!.manifest?.resources).toMatchObject({
    model: base + 'models/main.json',
    texture: base + 'textures/body.png',
  })
})
