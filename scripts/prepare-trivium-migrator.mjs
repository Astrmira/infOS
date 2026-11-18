import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const version = '0.9.2'
const commit = '04a9bcb656c82202c63e073dfda2ce9f74867535'
const extension = process.platform === 'win32' ? '.exe' : ''
const target = path.join(root, 'dist-daemon', 'bin', `${process.platform}-${process.arch}`, `triviumdb-migrate-${version}${extension}`)

function verify(binary) {
  const protocol = JSON.parse(execFileSync(binary, ['--protocol'], { encoding: 'utf8', windowsHide: true }))
  if (protocol.tool !== 'tdb-migrate-2' || protocol.protocol !== 1 || protocol.target_format !== 15 || !protocol.source_formats.includes(10))
    throw new Error('TRIVIUM_MIGRATOR_PROTOCOL_MISMATCH')
}

export function prepareTriviumMigrator() {
  if (existsSync(target)) {
    verify(target)
    return target
  }
  const source = process.env.INFOS_TRIVIUM_MIGRATOR
  if (!source) {
    const temp = path.join(root, 'TEMP')
    mkdirSync(temp, { recursive: true })
    const working = mkdtempSync(path.join(temp, 'trivium-build-'))
    const checkout = path.join(working, 'source')
    const output = path.join(working, 'target')
    try {
      execFileSync('git', ['clone', '--depth', '1', '--branch', `v${version}`, 'https://github.com/YoKONCy/TriviumDB.git', checkout], { stdio: 'inherit' })
      if (execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== commit)
        throw new Error('TRIVIUM_MIGRATOR_SOURCE_MISMATCH')
      execFileSync('cargo', ['build', '--locked', '--release', '--manifest-path', path.join(checkout, 'crates/triviumdb-migrate/Cargo.toml'), '--target-dir', output], { cwd: checkout, stdio: 'inherit' })
      install(path.join(output, 'release', `triviumdb-migrate${extension}`))
    } finally {
      rmSync(working, { recursive: true, force: true })
    }
  } else {
    if (!path.isAbsolute(source)) throw new Error('TRIVIUM_MIGRATOR_ABSOLUTE_PATH_REQUIRED')
    install(source)
  }
  return target
}

function install(binary) {
  mkdirSync(path.dirname(target), { recursive: true })
  const temp = `${target}.${randomUUID()}${extension}`
  try {
    copyFileSync(binary, temp)
    chmodSync(temp, 0o755)
    verify(temp)
    renameSync(temp, target)
  } finally {
    rmSync(temp, { force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) prepareTriviumMigrator()
