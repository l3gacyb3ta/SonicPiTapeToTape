// Custom VitePress theme: default theme + a "Run/Stop" button on every Ruby
// code block, backed by a single shared SonicPiEngine (the same engine the
// live editor and the npm package use). Decoration is progressive — it scans
// the rendered DOM, so it covers all ```ruby fences with no per-fence markup.
import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import Layout from './Layout.vue'

export default {
  extends: DefaultTheme,
  Layout,
} satisfies Theme
