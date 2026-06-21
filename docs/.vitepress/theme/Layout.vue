<script setup lang="ts">
import DefaultTheme from 'vitepress/theme'
import { useRoute } from 'vitepress'
import { onMounted, watch, nextTick } from 'vue'

const { Layout } = DefaultTheme
const route = useRoute()

// Decorate Ruby code blocks after each page renders (client only). VitePress is
// an SPA, so re-run on route change too.
async function enhance() {
  if (import.meta.env.SSR) return
  const { decorateRubyBlocks } = await import('./player')
  await nextTick()
  decorateRubyBlocks()
}

onMounted(enhance)
watch(() => route.path, () => { enhance() })
</script>

<template>
  <Layout />
</template>
