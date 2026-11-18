<script setup lang="ts">
import { t } from '../../i18n'
</script>

<template>
  <div class="main-wait" role="status">
    <svg class="main-wait__scene" viewBox="0 0 42 24" fill="none" aria-hidden="true" focusable="false">
      <g class="main-wait__cat">
        <path class="fur" d="M3 18V9h2V3h2v2h2v2h7V5h2V3h2v7h2v8h-2v2H5v-2Z" />
        <path class="coat" d="M5 16v-5h2V8h2v1h7V8h2v3h2v6h-2v1H7v-2Z" />
        <path class="blush" d="M5 6h2v2H5zm12 1h2v2h-2zM6 15h3v1H6zm10 0h3v1h-3z" />
        <path class="main-wait__eyes ink" d="M8 11h2v3H8zm7 0h2v3h-2z" />
        <path class="ink" d="M12 14h2v1h-2z" />
      </g>
      <g class="main-wait__letter" shape-rendering="crispEdges">
        <path class="paper" d="M21 12h15v10H21z" />
        <path class="fold" d="M21.5 12.5h14v9h-14zM22 13l6.5 5 6.5-5" />
      </g>
      <path class="main-wait__paw fur" d="M17 17h2v-1h3v1h2v2h-2v1h-4v-1h-1Z" />
      <path class="main-wait__spark blush" d="M37 5h1v2h2v1h-2v2h-1V8h-2V7h2Z" />
    </svg>
    <span>{{ t('ui.chat', '等待中……') }}</span>
  </div>
</template>

<style scoped>
.main-wait {
  display: inline-flex;
  align-self: flex-start;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  color: var(--ui-text-secondary);
  font-size: 13px;
}
.main-wait__scene { width: 48px; height: auto; flex: none; }
.fur { fill: var(--ui-accent-purple); }
.coat, .paper { fill: var(--ui-bg-surface); }
.ink { fill: var(--ui-text-primary); }
.blush { fill: var(--ui-accent-primary); }
.fold { stroke: var(--ui-accent-primary); }
.main-wait__cat, .main-wait__eyes, .main-wait__letter, .main-wait__paw, .main-wait__spark {
  animation: 2.8s ease-in-out infinite;
  transform-box: fill-box;
}
.main-wait__cat { transform-origin: bottom right; animation-name: cat-lean; }
.main-wait__eyes { transform-origin: center; animation-name: cat-blink; }
.main-wait__paw { animation-name: paw-tap; }
.main-wait__letter { transform-origin: bottom right; animation-name: letter-tip; }
.main-wait__spark { transform-origin: center; animation-name: letter-spark; }
@keyframes cat-lean { 0%, 55%, 100% { transform: none; } 28%, 35% { transform: rotate(5deg); } }
@keyframes cat-blink { 0%, 70%, 78%, 100% { transform: none; } 74% { transform: scaleY(.22); } }
@keyframes paw-tap { 0%, 52%, 100% { transform: none; } 25% { transform: translate(2px, -3px); } 34% { transform: translate(3px, -1px); } }
@keyframes letter-tip { 0%, 28%, 60%, 100% { transform: none; } 38% { transform: rotate(9deg); } 49% { transform: rotate(-3deg); } }
@keyframes letter-spark { 0%, 30%, 62%, 100% { opacity: 0; transform: scale(.5); } 41% { opacity: 1; transform: scale(1); } 56% { opacity: 0; transform: translateY(-2px); } }
[data-motion='reduced'] .main-wait__scene *,
[data-motion='off'] .main-wait__scene * { animation: none; }
@media (prefers-reduced-motion: reduce) {
  .main-wait__scene * { animation: none; }
}
</style>
