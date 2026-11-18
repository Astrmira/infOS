<script setup lang="ts">
import { computed } from 'vue'
import { useCompositorStore } from '../../stores/useCompositorStore'
import type { ChatMessage } from '../../stores/useThreadStore'
import MessageBubble, { type ChatMessage as BubbleMessage } from './MessageBubble.vue'

const props = defineProps<{ shell: ChatMessage; mainWaiting?: boolean }>()
const compositor = useCompositorStore()
const thinking = computed(() => {
  const { rawContent, role } = props.shell
  if (role !== 'assistant' || !rawContent) return undefined
  const pattern = /<(innerVoice|selfMinding|think|thinking|thought)(?:\s[^>]*)?>\s*([\s\S]*?)\s*<\/\1>/gi
  const blocks = [...rawContent.matchAll(pattern)].map(match => match[2]?.trim()).filter(Boolean)
  return blocks.join('\n\n') || undefined
})

const message = computed<BubbleMessage>(() => {
  const shell = props.shell
  const surface = props.mainWaiting ? undefined : compositor.get(shell.surfaceId)
  return {
    id: shell.id,
    role: shell.role,
    content: shell.content,
    queuePreview: shell.queuePreview,
    executionRecord: shell.executionRecord,
    timestamp: shell.timestamp ? new Date(shell.timestamp).getTime() : undefined,
    thinkingContent: props.mainWaiting || surface?.processCollapsed ||
      surface?.nodes.some(node => node.kind === 'thinking' || node.kind === 'native-reasoning')
      ? undefined : thinking.value,
    outputTokens: shell.outputTokens,
    spokenReply: shell.spokenReply,
    senderId: shell.senderId,
    ragFailureTrace: shell.ragFailureTrace,
    imageTranscription: shell.imageTranscription,
    surface,
  }
})
</script>

<template>
  <MessageBubble :message="message" :main-waiting="mainWaiting" />
</template>
