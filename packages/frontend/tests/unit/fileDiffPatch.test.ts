import { describe, expect, it } from 'vitest'
import { parsePatchFiles } from '@pierre/diffs'
import { fileDiffPatches } from '../../src/lib/fileDiffPatch'

describe('文件差异补丁数据契约', () => {
  it('保留变更片段的原始行号与完整内容', () => {
    const patches = fileDiffPatches([
      { kind: 'context', oldLine: 8, newLine: 8, text: '共有内容' },
      { kind: 'remove', oldLine: 9, text: '旧内容' },
      { kind: 'add', newLine: 9, text: '新内容' },
      { kind: 'add', newLine: 10, text: '<script>原样保留</script>' },
      { kind: 'context', oldLine: 10, newLine: 11, text: '结尾' },
    ], 'src/a.ts')
    expect(patches).toEqual([
      'diff --git "a/src/a.ts" "b/src/a.ts"\n--- "a/src/a.ts"\n+++ "b/src/a.ts"\n' +
      '@@ -8,3 +8,4 @@\n 共有内容\n-旧内容\n+新内容\n+<script>原样保留</script>\n 结尾\n',
    ])
    const files = parsePatchFiles(patches![0]!, { throwOnError: true })[0]!.files
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ name: 'src/a.ts', hunks: [{ deletionStart: 8, additionStart: 8 }] })
  })

  it('批量步骤行号重新开始时形成独立片段', () => {
    expect(fileDiffPatches([
      { kind: 'remove', oldLine: 1, text: '第一处旧文' },
      { kind: 'add', newLine: 1, text: '第一处新文' },
      { kind: 'remove', oldLine: 1, text: '第二处旧文' },
      { kind: 'add', newLine: 1, text: '第二处新文' },
    ], 'a.txt')).toEqual([
      'diff --git "a/a.txt" "b/a.txt"\n--- "a/a.txt"\n+++ "b/a.txt"\n' +
      '@@ -1,1 +1,1 @@\n-第一处旧文\n+第一处新文\n',
      'diff --git "a/a.txt" "b/a.txt"\n--- "a/a.txt"\n+++ "b/a.txt"\n' +
      '@@ -1,1 +1,1 @@\n-第二处旧文\n+第二处新文\n',
    ])
  })

  it('缺失的中间行保持为空缺，后续片段保留真实起始位置', () => {
    const patches = fileDiffPatches([
      { kind: 'context', oldLine: 2, newLine: 2, text: '前片段' },
      { kind: 'remove', oldLine: 40, text: '后片段旧文' },
      { kind: 'add', newLine: 43, text: '后片段新文' },
    ], 'a.txt')!
    expect(patches).toHaveLength(2)
    expect(patches[1]).toContain('@@ -40,1 +43,1 @@\n-后片段旧文\n+后片段新文\n')
  })

  it('只增加与只删除的片段可以被正式解析器读取', () => {
    const additions = fileDiffPatches([{ kind: 'add', newLine: 1, text: '新增' }], '新增.txt')!
    const deletions = fileDiffPatches([{ kind: 'remove', oldLine: 5, text: '删除' }], '删除.txt')!
    expect(additions[0]).toContain('@@ -0,0 +1,1 @@\n+新增\n')
    expect(deletions[0]).toContain('@@ -5,1 +0,0 @@\n-删除\n')
    expect(parsePatchFiles(additions[0]!, { throwOnError: true })[0]!.files[0]?.name).toBe('新增.txt')
    expect(parsePatchFiles(deletions[0]!, { throwOnError: true })[0]!.files[0]?.name).toBe('删除.txt')
  })

  it('路径中的引号与换行以文件名数据传递', () => {
    const patches = fileDiffPatches([{ kind: 'add', newLine: 1, text: '内容' }], '目录/"名字\n.txt')!
    expect(parsePatchFiles(patches[0]!, { throwOnError: true })[0]!.files[0]?.name)
      .toBe('目录/"名字\n.txt')
  })

  it('缺失行号或多行文本由原始数据通道处理', () => {
    expect(fileDiffPatches([{ kind: 'remove', text: '无行号' }], 'a.txt')).toBeNull()
    expect(fileDiffPatches([{ kind: 'add', newLine: 0, text: '错误行号' }], 'a.txt')).toBeNull()
    expect(fileDiffPatches([{ kind: 'add', newLine: 1, text: '一\n二' }], 'a.txt')).toBeNull()
    expect(fileDiffPatches([], 'a.txt')).toEqual([])
  })
})
