import type { FileDiffRow } from './fileMutationDiff'

/** 将已有预览行转为独立补丁片段，保留批量步骤各自的行号。 */
export function fileDiffPatches(rows: readonly FileDiffRow[], path: string): string[] | null {
  const name = path.replaceAll('\\', '/') || 'file'
  const oldName = JSON.stringify(`a/${name}`)
  const newName = JSON.stringify(`b/${name}`)
  const header = `diff --git ${oldName} ${newName}\n--- ${oldName}\n+++ ${newName}\n`
  const patches: string[] = []
  let lines: string[] = []
  let oldStart = 0
  let newStart = 0
  let oldCount = 0
  let newCount = 0
  let nextOld: number | undefined
  let nextNew: number | undefined

  const flush = () => {
    if (!lines.length) return
    patches.push(`${header}@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${lines.join('\n')}\n`)
    lines = []
    oldStart = newStart = oldCount = newCount = 0
    nextOld = nextNew = undefined
  }
  for (const row of rows) {
    const oldLine = row.kind === 'add' ? undefined : row.oldLine
    const newLine = row.kind === 'remove' ? undefined : row.newLine
    // 来源缺少行号或行内容跨行时，继续使用原始预览，避免补造位置。
    if (
      /[\r\n]/.test(row.text) ||
      (row.kind !== 'add' && (!Number.isSafeInteger(oldLine) || oldLine! < 1)) ||
      (row.kind !== 'remove' && (!Number.isSafeInteger(newLine) || newLine! < 1))
    ) return null
    if (
      (oldLine !== undefined && nextOld !== undefined && oldLine !== nextOld) ||
      (newLine !== undefined && nextNew !== undefined && newLine !== nextNew)
    ) flush()
    if (oldLine !== undefined) {
      if (oldCount === 0) oldStart = oldLine
      oldCount++
      nextOld = oldLine + 1
    }
    if (newLine !== undefined) {
      if (newCount === 0) newStart = newLine
      newCount++
      nextNew = newLine + 1
    }
    lines.push(`${row.kind === 'add' ? '+' : row.kind === 'remove' ? '-' : ' '}${row.text}`)
  }
  flush()
  return patches
}
