import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync, constants, copyFileSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync,
  readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLogger } from '../lib/logger'
import { t } from '../lib/i18n'
import {
  assertManagedFilePath, backupLegacyStore, databaseFormat, digest, managedRelative,
  syncDirectory, triviumFiles, TRIVIUM_FORMAT, TRIVIUM_VERSION, upgradeBackupPath,
} from './triviumFiles'

const run = promisify(execFile)
const log = createLogger('TriviumMigration')
const hex = /^[a-f0-9]{64}$/
const commandOptions = { encoding: 'utf8', windowsHide: true } as const
const MiB = 1024 * 1024

async function resolveMigrator(): Promise<string> {
  const resources = process.env.INFOS_RESOURCES_ROOT
  const root = fileURLToPath(new URL('../../../../', import.meta.url))
  const name = `triviumdb-migrate-${TRIVIUM_VERSION}${process.platform === 'win32' ? '.exe' : ''}`
  const binary = path.join(
    resources ?? path.join(root, 'dist-daemon'), 'bin', `${process.platform}-${process.arch}`, name,
  )
  if (!resources && !existsSync(binary)) {
    const prepare = path.join(root, 'scripts', 'prepare-trivium-migrator.mjs')
    await run(process.execPath, [prepare], commandOptions)
  }
  const info = JSON.parse((await run(binary, ['--protocol'], commandOptions)).stdout)
  if (info.tool !== 'tdb-migrate-2' || info.protocol !== 1 || info.target_format !== TRIVIUM_FORMAT)
    throw new Error('TRIVIUM_MIGRATOR_PROTOCOL_MISMATCH')
  return binary
}

function inventory(base: string) {
  return triviumFiles(base).filter(file => file !== base + '.lock').map(file => ({
    suffix: file.slice(base.length), ...digest(file),
  }))
}

type Inventory = ReturnType<typeof inventory>
const fingerprint = (entries: Inventory) => createHash('sha256').update(JSON.stringify(entries)).digest('hex')

function readJson(root: string, file: string) {
  assertManagedFilePath(root, file)
  return JSON.parse(readFileSync(file, 'utf8'))
}

// 切换意图先于任何业务文件替换落盘。原始备份、转换结果、业务库三者各自独立。
function publish(root: string, target: string, journal: string, verified?: Inventory): void {
  const { backup, checksum } = readJson(root, journal) as { backup: string; checksum: string }
  if (!hex.test(backup) || !hex.test(checksum)) throw new Error('TRIVIUM_MIGRATION_INVALID_JOURNAL')
  const converted = path.join(upgradeBackupPath(root, target), backup, 'converted')
  const base = path.join(converted, 'database.tdb')
  assertManagedFilePath(root, base)
  const files = verified ?? inventory(base)
  if (databaseFormat(base) !== TRIVIUM_FORMAT || fingerprint(files) !== checksum)
    throw new Error('TRIVIUM_MIGRATION_CANDIDATE_CHANGED')
  const suffixes = new Set(files.map(entry => entry.suffix))
  const temporary = journal + '.install'
  assertManagedFilePath(root, temporary)
  const old = triviumFiles(target)
  for (const entry of files) {
    const destination = target + entry.suffix
    rmSync(temporary, { force: true })
    copyFileSync(base + entry.suffix, temporary, constants.COPYFILE_EXCL)
    const fd = openSync(temporary, 'r+')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    if (digest(temporary).sha256 !== entry.sha256) throw new Error('TRIVIUM_MIGRATION_COPY_FAILED')
    renameSync(temporary, destination)
  }
  for (const file of old) {
    const suffix = file.slice(target.length)
    if (suffix !== '.dimension' && suffix !== '.lock' && !suffixes.has(suffix)) rmSync(file)
  }
  syncDirectory(path.dirname(target))
  rmSync(journal)
  syncDirectory(path.dirname(target))
  // 档案只需长期保留旧库与原始清单；成功交付后回收候选库占用的磁盘。
  // 先整体移出迁移器的交付路径，中断清理也能用相同旧库再次恢复。
  const garbage = path.join(path.dirname(converted), `installed-${randomUUID()}`)
  try {
    assertManagedFilePath(root, garbage)
    renameSync(converted, garbage)
    rmSync(garbage, { recursive: true })
  } catch (error) {
    log.warn(t('logs.repositories', '已完成升级，临时文件清理失败：{0}', [String(error)]))
  }
}

/** 大库按原生引擎报告的实际需求重试；每次转换仍由上游检查可用磁盘和来源租约。 */
async function runConversion(binary: string, target: string, converted: string, sourceMiB: number) {
  let memoryMiB = 256
  for (;;) {
    try {
      const { stdout } = await run(binary, [
        '--source', target, '--destination', converted, '--execute', '--source-dtype', 'f32',
        '--storage', 'mmap', '--memory-mib', String(memoryMiB), '--max-source-mib', String(sourceMiB),
        '--max-work-mib', String(6 * sourceMiB + 8 * memoryMiB + 64),
      ], commandOptions)
      return JSON.parse(stdout)
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr
      let failure
      try {
        failure = JSON.parse(stderr ?? '').error
      } catch {
        throw error
      }
      if (failure?.code !== 'TDB_CAPACITY_RESERVATION_REJECTED' || failure.outcome !== 'not_committed')
        throw error
      const required = Number(failure.details.current_bytes) + Number(failure.details.estimated_bytes)
      const next = Math.max(2 * memoryMiB, Math.ceil(required / MiB))
      if (!Number.isSafeInteger(required) || required <= memoryMiB * MiB || next * MiB > process.availableMemory())
        throw error
      memoryMiB = next
    }
  }
}

async function convert(root: string, target: string, format: number, binary: string, journal: string) {
  // 与原生工具约定一致，恢复包可以省略空锁文件。先补建，重试时来源指纹保持稳定。
  assertManagedFilePath(root, target + '.lock')
  if (!existsSync(target + '.lock')) closeSync(openSync(target + '.lock', 'wx', 0o600))
  const backup = backupLegacyStore(root, target, format)
  const converted = path.join(backup, 'converted')
  assertManagedFilePath(root, converted)
  const manifest = readJson(root, path.join(backup, 'backup.json')) as {
    files: Array<{ name: string; size: number; sha256: string }>
  }
  const bytes = manifest.files.reduce((total, item) => total + item.size, 0)
  const report = await runConversion(binary, target, converted, Math.max(1, Math.ceil(bytes / MiB)))
  if (report.tool !== 'tdb-migrate-2' || report.protocol !== 1 || report.source_format !== format ||
      report.target_format !== TRIVIUM_FORMAT || report.dtype !== 'f32' || !report.checked || !report.committed)
    throw new Error('TRIVIUM_MIGRATION_UNVERIFIED_RESULT')
  // 对照迁移器持有来源排他锁时读取的摘要，确保留作回退的制品与实际转换来源一致。
  const owner = readJson(root, path.join(converted, 'migration-source.json')) as {
    files: Record<string, { bytes: number; sha256: string }>
  }
  const prefixLength = path.basename(target).length
  const archived = manifest.files.filter(({ name }) => !['.dimension', '.lock'].includes(name.slice(prefixLength)))
  if (Object.keys(owner.files).length !== archived.length || archived.some(entry => {
    const source = owner.files[entry.name.slice(prefixLength)]
    return !source || source.sha256 !== entry.sha256 || source.bytes !== entry.size
  })) throw new Error('TRIVIUM_MIGRATION_BACKUP_MISMATCH')
  const base = path.join(converted, 'database.tdb')
  const files = inventory(base)
  if (databaseFormat(base) !== TRIVIUM_FORMAT || existsSync(base + '.migration'))
    throw new Error('TRIVIUM_MIGRATION_UNVERIFIED_RESULT')
  const pending = journal + '.new'
  assertManagedFilePath(root, pending)
  rmSync(pending, { force: true })
  const intent = { backup: path.basename(backup), checksum: fingerprint(files) }
  writeFileSync(pending, JSON.stringify(intent), { flag: 'wx', mode: 0o600, flush: true })
  renameSync(pending, journal)
  syncDirectory(path.dirname(target))
  return files
}

/** 在实例租约内、业务库打开前逐库升级。重启时先完成已登记的切换，即使主文件已显示新版。 */
export async function migrateTriviumStores(
  root: string,
  options: { recoverOnly?: boolean; onActivity?: (active: boolean) => void } = {},
): Promise<void> {
  let binary: string | undefined
  let active = false
  try {
    for (const directory of readdirSync(root, { withFileTypes: true })) {
      const names = directory.name === 'knowledge' ? ['facts', 'knowledge']
        : /^agent_[\w-]+$/.test(directory.name) ? ['memory', 'social'] : []
      if (!names.length) continue
      if (directory.isSymbolicLink()) throw new Error('TRIVIUM_MIGRATION_UNSAFE_DIRECTORY')
      if (!directory.isDirectory()) continue
      for (const name of names) {
        const target = path.resolve(root, directory.name, name + '.tdb')
        const journal = target + '.infos-upgrade-v15'
        assertManagedFilePath(root, target)
        assertManagedFilePath(root, journal)
        const pending = existsSync(journal)
        if (options.recoverOnly && !pending) continue
        const format = pending ? null : databaseFormat(target)
        if (!pending && (format === null || format === TRIVIUM_FORMAT)) {
          if (format === null && (lstatSync(target + '.wal', { throwIfNoEntry: false })?.size ?? 0) > 6)
            throw new Error(`TRIVIUM_MIGRATION_MISSING_CHECKPOINT: ${target}`)
          continue
        }
        if (!active) {
          active = true
          options.onActivity?.(true)
        }
        try {
          log.info(t('logs.repositories', '正在升级记忆数据库：{0}', [managedRelative(root, target)]))
          let verified: Inventory | undefined
          if (!pending && format !== null) {
            if (format < 5 || format > TRIVIUM_FORMAT) throw new Error(`TRIVIUM_UNSUPPORTED_FORMAT: ${format}`)
            binary ??= await resolveMigrator()
            verified = await convert(root, target, format, binary, journal)
          }
          publish(root, target, journal, verified)
        } catch (error) {
          throw new Error(t('logs.repositories', '记忆数据库升级未完成：{0}（{1}）', [target, String(error)]), { cause: error })
        }
      }
    }
  } finally {
    if (active) options.onActivity?.(false)
  }
}
