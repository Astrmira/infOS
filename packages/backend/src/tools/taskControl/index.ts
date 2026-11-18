import type { TaskControlInput } from '@infos/shared'
import type { BuiltinTool } from '../index'
import { getTaskToolRuntime } from './runtime'
import { toolSuccess } from '../../services/execution/toolResult'
export const manageTaskTool: BuiltinTool = {
  name: 'manage_task',
  allowedSources: ['desktop'],
  async execute(args, ctx) {
    const input = args as unknown as TaskControlInput
    const receipt = await getTaskToolRuntime().control(ctx.agentId, input, ctx.threadId, {
      taskId: ctx.taskId,
      executionId: ctx.executionId,
      callId: ctx.toolCallId,
      requestedBy: ctx.requestedBy,
    })
    const output = JSON.stringify(receipt)
    const content = input.action === 'create' ? input.message?.trim() : undefined
    if (!ctx.conversation || ctx.sceneRoomId || ctx.taskId || ctx.realmId || !content) return output
    if (!receipt || typeof receipt !== 'object' || !('id' in receipt) || typeof receipt.id !== 'string' ||
        !('status' in receipt) || (receipt.status !== 'queued' && receipt.status !== 'running')) return output
    // 任务已有持久编号才发表受理回执，前台随即可以结束，后台独立推进。
    const publication = await ctx.conversation.publish({ id: `dispatch-${receipt.id}`, content })
    return { ...toolSuccess(output, { conversationMessage: { ...publication, content } }), shouldTerminate: true }
  },
}
