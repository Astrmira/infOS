/** 待发送消息独立于对话历史，派发后才成为正式用户消息。 */
export interface QueuedConversationInput {
  threadId: string
  expectedGeneration?: number
  agentId?: string
  content: string
  /** 主会话可显式要求另起一次执行，默认在本次执行的下一次模型调用前接收。 */
  delivery?: 'next_turn'
  /** 由服务端于入队事务内确定，客户端不能指定正在执行的目标。 */
  supplementTo?: string
  attachmentIds?: string[]
  imageMode?: 'auto' | 'native' | 'relay'
  /** 仅宿主内部填写；HTTP 消息结构不接受该字段。 */
  taskResultEvent?: { deliveryId: string; taskId: string }
  /** 由重新生成入口核验后填写，普通发送接口无法设置。 */
  regeneration?: { messageId: number; revision: number }
  /** 仅 HTTP 鉴权边界填写并持久化，消息正文不能自报成就身份。 */
  achievementSubjectId?: string
  /** 桌面客户端记下的环境事件，只注入本轮模型上下文。 */
  environmentEvents?: import('./types/desktopHome').DesktopEnvironmentEvent[]
  workspaceContext?: {
    filePath?: string
    fileHash?: string
    fileDirty?: boolean
    terminalId?: string
    selection?: { text: string; startLine: number; endLine: number }
  }
}

export interface ConversationQueueItem {
  id: string
  revision: number
  position: number
  state: 'queued' | 'running' | 'draft' | 'completed' | 'failed' | 'interrupted' | 'cancelled'
  input: QueuedConversationInput
  immediate: boolean
  createdAt: number
  error?: string
}

export interface ConversationQueueSnapshot {
  threadId: string
  /** 最近一次队列终态仍对应当前历史首页时，返回该帧的操作标识。 */
  terminalOperationId?: string
  active?: boolean
  paused: boolean
  reason?: string
  items: ConversationQueueItem[]
  /** 已从派发队列取回、等待输入栏接收的草稿，不参与队列计数。 */
  drafts?: ConversationQueueItem[]
}
