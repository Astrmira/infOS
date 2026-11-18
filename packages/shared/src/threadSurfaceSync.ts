import type {
  ConversationMessageProjection,
  ConversationProjectionSnapshot,
  SurfaceDescriptor,
  SurfaceFrame,
} from './types/surface.types'

export const THREAD_SURFACE_SYNC = 'thread-surface-sync-v1'

export interface ProjectionBaseline {
  operationId: string
  snapshot: ConversationProjectionSnapshot
}

type Snapshot = ConversationProjectionSnapshot
type CompactSnapshot = Omit<Snapshot, 'messages' | 'surfaces'> & {
  messages: (string | ConversationMessageProjection)[]
  surfaces: (string | SurfaceDescriptor)[]
}
type SnapshotOp = Extract<SurfaceFrame['operation'], { snapshot: Snapshot }>
type WithCompactSnapshot<T> = T extends SnapshotOp
  ? Omit<T, 'snapshot'> & { snapshot: CompactSnapshot }
  : never
export type DeltaFrame = Omit<SurfaceFrame, 'operation'> & {
  baseOperationId: string
  operation: WithCompactSnapshot<SnapshotOp>
}

export function projectionBaseline(frame: SurfaceFrame): ProjectionBaseline | undefined {
  if ('snapshot' in frame.operation && frame.threadId === frame.operation.snapshot.threadId)
    return { operationId: frame.operationId, snapshot: frame.operation.snapshot }
}

function sameHistory(previous: Snapshot, next: CompactSnapshot) {
  return (
    previous.threadId === next.threadId &&
    previous.principalId === next.principalId &&
    previous.threadGeneration === next.threadGeneration
  )
}

/** 引用上一份已交付页面中的相同记录。顺序由新页面决定，移出窗口与真正撤回各自保留原语义。 */
export function compactProjection(
  frame: SurfaceFrame,
  base: ProjectionBaseline,
  equal: (left: unknown, right: unknown) => boolean,
): DeltaFrame | undefined {
  const operation = frame.operation
  if (
    !('snapshot' in operation) ||
    frame.threadId !== operation.snapshot.threadId ||
    !sameHistory(base.snapshot, operation.snapshot)
  )
    return
  let reused = false
  function compact<T>(old: T[], next: T[], key: (row: T) => string) {
    const rows = new Map(old.map((row) => [key(row), row]))
    if (rows.size !== old.length) return next
    return next.map((row) => {
      const id = key(row)
      const saved = rows.get(id)
      if (saved === undefined || !equal(saved, row)) return row
      rows.delete(id)
      reused = true
      return id
    })
  }
  const page = operation.snapshot
  const snapshot = {
    ...page,
    messages: compact(base.snapshot.messages, page.messages, (item) => item.messageId),
    surfaces: compact(base.snapshot.surfaces, page.surfaces, (item) => item.surfaceId),
  }
  if (reused)
    return { ...frame, baseOperationId: base.operationId, operation: { ...operation, snapshot } }
}

export function expandProjection(frame: DeltaFrame, base?: ProjectionBaseline): SurfaceFrame {
  const { baseOperationId, operation, ...header } = frame
  const page = operation.snapshot
  if (
    !base ||
    base.operationId !== baseOperationId ||
    header.threadId !== page.threadId ||
    !sameHistory(base.snapshot, page) ||
    !['surface.commit', 'surface.publish', 'surface.settled'].includes(operation.type)
  )
    throw new Error('SURFACE_DELTA_BASE_INVALID')
  function expand<T>(old: T[], next: (T | string)[], key: (row: T) => string): T[] {
    const rows = new Map(old.map((row) => [key(row), row]))
    return next.map((item) => {
      if (typeof item !== 'string') return item
      const row = rows.get(item)
      if (!row) throw new Error('SURFACE_DELTA_REFERENCE_INVALID')
      rows.delete(item)
      return row
    })
  }
  return {
    ...header,
    operation: {
      ...operation,
      snapshot: {
        ...page,
        messages: expand(base.snapshot.messages, page.messages, (item) => item.messageId),
        surfaces: expand(base.snapshot.surfaces, page.surfaces, (item) => item.surfaceId),
      },
    },
  }
}
