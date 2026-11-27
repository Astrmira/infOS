import { createHmac } from 'node:crypto'
import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { SAFETY_LISTS } from '../../../packages/shared/src/desktopSafety'
import { DesktopGuard, type GuardOutcome } from './desktopGuardCore'
import type { DesktopGuardDeps, GuardAnswer, GuardPrompt } from './desktopGuardModel'
import { createSafeStorageSigner } from './settingsSigner'

vi.mock('electron', () => ({
  app: {},
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
}))
vi.mock('../utils/logger', () => ({ logger: { error: vi.fn() } }))

const edge = { program: 'msedge.exe', title: '新标签页 和另外 20 个页面 - 个人 - Microsoft Edge' }
const sign = (payload: string) => createHmac('sha256', 'fixture').update(payload).digest('base64')

function fixture() {
  const directory = mkdtempSync(path.join(process.env.PERO_DATA_DIR!, 'desktop-guard-'))
  const userFile = path.join(directory, 'desktop-safety.json')
  const accepted = path.join(directory, 'desktop-safety.accepted.json')
  const prompt = vi.fn<(request: GuardPrompt) => Promise<GuardAnswer>>().mockResolvedValue('deny')
  const deps: DesktopGuardDeps = {
    draft: SAFETY_LISTS, selfPrograms: () => ['infOS.exe'], now: Date.now,
    userFile: () => userFile, acceptedFile: () => accepted,
    signer: { sign }, prompt,
  }
  return { guard: new DesktopGuard(deps), deps, userFile, accepted, prompt }
}

it('其他设置已经使用签名密钥时，首次访问 Edge 也无需本机护栏授权', async () => {
  const { deps, userFile, prompt } = fixture()
  const key = () => path.join(path.dirname(userFile), 'infos-settings.key')
  createSafeStorageSigner(key).sign('desktop-control')
  const guard = new DesktopGuard({ ...deps, signer: createSafeStorageSigner(key) })
  expect(guard.state()).toMatchObject({ draftValid: true, settings: { enabled: false }, fileIssues: [] })
  const outcome: GuardOutcome = { prompted: false }
  await expect(guard.check({}, edge, '搜索', false, null, outcome)).resolves.toBe('normal')
  expect(outcome).toEqual({ prompted: false })
  await expect(guard.plan({}, ['msedge'], '')).resolves.toMatchObject({ approved: false, covered: [] })
  await expect(guard.change({ enabled: true }, 'agent')).rejects.toThrow('DESKTOP_SAFETY_INVALID')
  await expect(guard.check({}, { program: 'shortcut', launchIdentities: ['infOS.exe'] }, '', false)).rejects.toThrow('DESKTOP_FORBIDDEN')
  await expect(guard.check({}, { program: 'consent.exe' }, '', false)).rejects.toThrow('DESKTOP_FORBIDDEN')
  expect(prompt).not.toHaveBeenCalled()
  await expect(guard.confirmEach(edge, '搜索')).rejects.toThrow('DESKTOP_APPROVAL_DENIED')
  expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ manual: true, ask: 'every' }))
})

it('手动开启后区分 Edge 和命令行，只有用户确认关闭后才停用规则', async () => {
  const { guard, deps, prompt } = fixture()
  await guard.setEnabled(true)
  expect(guard.classify(edge)).toEqual({ zone: 'normal', reason: 'program', program: 'msedge' })
  expect(guard.classify({ program: 'cmd.exe' }).zone).toBe('mustConfirm')
  await expect(guard.check({}, edge, '', false)).rejects.toThrow('DESKTOP_APPROVAL_DENIED')
  expect(prompt).toHaveBeenLastCalledWith(expect.objectContaining({ ask: 'once' }))
  await expect(guard.setEnabled(false)).resolves.toMatchObject({ settings: { enabled: true } })
  expect(prompt).toHaveBeenLastCalledWith(expect.objectContaining({ changes: [{ kind: 'disable-guard' }] }))
  prompt.mockResolvedValueOnce('approve')
  await guard.setEnabled(false)
  const reloaded = new DesktopGuard(deps)
  expect(reloaded.state()).toMatchObject({ settings: { enabled: false }, fileIssues: [] })
  await expect(reloaded.check({}, { program: 'cmd.exe' }, '', false)).resolves.toBe('normal')
})

it('旧版有效签名沿用已确认的信任名单，改写开关则进入恢复模式', async () => {
  const { guard, accepted, userFile } = fixture()
  const settings = { version: 1, normalMode: 'once', forbidden: [], mustConfirm: [], trusted: ['msedge'] }
  const payload = JSON.stringify({ domain: 'desktop-safety', revision: 4, value: settings })
  const envelope = { ...settings, revision: 4, signature: sign(payload) }
  for (const file of [accepted, userFile]) writeFileSync(file, JSON.stringify(envelope))
  writeFileSync(accepted + '.confirmed', JSON.stringify({ signature: sign('confirmed:' + payload) }))
  expect(guard.state()).toMatchObject({ fileIssues: [], settings: { enabled: true } })
  await expect(guard.check({}, edge, '', false)).resolves.toBe('normal')
  writeFileSync(userFile, JSON.stringify({ ...envelope, enabled: false }))
  expect(guard.state()).toMatchObject({
    settings: { enabled: true, trusted: [] }, externalEdit: true,
    fileIssues: [{ code: 'SIGNATURE_INVALID', field: 'user.signature' }],
  })
  expect(guard.classify(edge).reason).toBe('draft-invalid')
})

it('关闭护栏暂停自定义名单，重新开启后恢复名单并重新询问会话授权', async () => {
  const { guard, prompt } = fixture()
  await guard.setEnabled(true)
  await guard.change({ forbid: ['notepad.exe'] }, 'user')
  prompt.mockResolvedValueOnce('thread')
  await guard.check({ threadId: 'chat' }, edge, '', false)
  prompt.mockResolvedValueOnce('approve')
  await guard.setEnabled(false)
  await expect(guard.check({}, { program: 'notepad.exe' }, '', false)).resolves.toBe('normal')
  await guard.setEnabled(true)
  await expect(guard.check({}, { program: 'notepad.exe' }, '', false)).rejects.toThrow('DESKTOP_FORBIDDEN')
  await expect(guard.check({ threadId: 'chat' }, edge, '', false)).rejects.toThrow('DESKTOP_APPROVAL_DENIED')
})

it('只剩独立确认凭据的旧安装需要恢复，不能按新配置放行', () => {
  const { guard, accepted } = fixture()
  writeFileSync(accepted + '.confirmed', '{}')
  expect(guard.state().fileIssues).toContainEqual({ code: 'BASELINE_INVALID', field: 'accepted' })
  expect(guard.classify(edge).zone).toBe('mustConfirm')
})

it('审批等待期间配置失效，迟到的批准不能把旧设置写回', async () => {
  const { guard, accepted, userFile, prompt } = fixture()
  await guard.setEnabled(true)
  const saved = readFileSync(userFile, 'utf8')
  prompt.mockImplementationOnce(async () => {
    unlinkSync(accepted + '.confirmed')
    return 'approve'
  })
  await expect(guard.setEnabled(false)).rejects.toThrow('DESKTOP_SAFETY_CHANGED')
  expect(readFileSync(userFile, 'utf8')).toBe(saved)
  expect(guard.state()).toMatchObject({ settings: { enabled: true }, fileIssues: [{ field: 'accepted.confirmation' }] })
})
