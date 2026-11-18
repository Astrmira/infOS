import type { ConversationQueueItem, QueuedConversationInput } from '@infos/shared'
import type { AttachmentRepository } from '../../repositories/attachment.repo'
import type { ConversationQueueRepository } from '../../repositories/conversationQueue.repo'
import type { ThreadRepository } from '../../repositories/thread.repo'
import type { AttachmentService } from '../attachment/attachmentService'
import type { ChatMessage } from '../pipeline/types'
import { AppError } from '../../lib/appError'
import { t } from '../../lib/i18n'

export interface SupplementContent {
  message: ChatMessage
  attachments?: ReturnType<AttachmentService['toDto']>[]
  transcription?: { content: string; metadataJson: string }
}

/** 把已准备好的队首补话一次提交给当前执行。附件读取、模型转述均在事务外完成。 */
export class MainConversationInbox {
  constructor(
    private readonly queue: ConversationQueueRepository,
    private readonly threads: ThreadRepository,
    private readonly attachments: AttachmentRepository,
    private readonly changed: (threadId: string) => void,
  ) {}

  async read(threadId: string, executionId: string, generation: number,
    prepare: (input: QueuedConversationInput) => Promise<SupplementContent>,
    signal?: AbortSignal): Promise<ChatMessage[]> {
    const messages: ChatMessage[] = []
    for (const item of this.queue.supplements(threadId, executionId)) {
      signal?.throwIfAborted()
      if (item.input.expectedGeneration !== generation) break
      let content: SupplementContent
      try {
        content = await prepare(item.input)
      } catch (error) {
        if (signal?.aborted) throw error
        // 让该输入独立走完整派发和错误反馈，保留已经接收的补话和当前回合。
        this.queue.deferSupplement(item)
        this.changed(threadId)
        break
      }
      signal?.throwIfAborted()
      let include = true
      if (!this.queue.acceptSupplement(threadId, executionId, item, () => {
        include = this.save(item, executionId, generation, content)
      })) break
      if (include) messages.push(content.message)
      else this.changed(threadId)
    }
    if (messages.length) this.changed(threadId)
    return messages
  }

  private save(item: ConversationQueueItem, executionId: string, generation: number, content: SupplementContent) {
    const { threadId, taskResultEvent, attachmentIds = [] } = item.input
    const conversations = this.threads.conversations
    if (taskResultEvent) {
      conversations.assertCurrent(executionId)
      const source = conversations.taskResultSource(threadId, taskResultEvent.taskId, taskResultEvent.deliveryId)
      if (source) conversations.appendInputSource(executionId, { messageId: source.id, revision: source.revision ?? 1 })
      return !!source || !taskResultEvent.deliveryId.endsWith(':resume')
    }
    const message = this.threads.appendMessageSync({
      threadId, executionId, expectedGeneration: generation, role: 'user', content: item.input.content,
      publicationId: `conversation:${threadId}:${generation}:${item.id}:input`,
      metadataJson: content.attachments?.length ? JSON.stringify({ attachments: content.attachments }) : undefined,
    })
    if (attachmentIds.length && this.attachments.bindSync(attachmentIds, threadId, message.id) !== attachmentIds.length)
      throw new AppError('CONFLICT', { message: t('errors.backend', '附件绑定状态已变化，请重新上传后重试') })
    if (content.transcription) this.threads.appendMessageSync({
      threadId, expectedGeneration: generation, role: 'system', ...content.transcription,
    })
    conversations.appendInputSource(executionId, { messageId: message.id, revision: message.revision ?? 1 })
    return true
  }
}
