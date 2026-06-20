import { defineConfig } from 'vitepress'
import { fileURLToPath, URL } from 'node:url'
import { createReadStream, existsSync } from 'node:fs'
import { join } from 'node:path'

// Repo root — so the docs theme can import the engine from ../src.
const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

// Dev only: the engine fetches /tree-sitter*.wasm at the ROOT, but VitePress dev
// serves under /docs/. Serve those two files from /public at root so tree-sitter
// loads (in production the main app at the domain root already serves them).
const serveRootWasm = {
  name: 'serve-root-wasm',
  configureServer(server: any) {
    server.middlewares.use((req: any, res: any, next: any) => {
      if (req.url === '/tree-sitter.wasm' || req.url === '/tree-sitter-ruby.wasm') {
        const f = join(repoRoot, 'public', req.url.slice(1))
        if (existsSync(f)) {
          res.setHeader('Content-Type', 'application/wasm')
          createReadStream(f).pipe(res)
          return
        }
      }
      next()
    })
  },
}

export default defineConfig({
  title: 'SonicPi.js',
  description: 'Browser-native Sonic Pi with real SuperCollider synthesis via WebAssembly.',
  base: '/docs/',
  outDir: '../dist/docs',

  vite: {
    server: { fs: { allow: [repoRoot] } },
    plugins: [serveRootWasm],
  },

  head: [
    ['link', { rel: 'icon', href: '/docs/favicon.svg' }],
  ],

  themeConfig: {
    logo: { src: '/docs/favicon.svg', alt: 'SonicPi.js' },

    nav: [
      { text: 'Try it', link: 'https://sonicpi.cc' },
      { text: 'npm', link: 'https://www.npmjs.com/package/@mjayb/sonicpijs' },
      { text: 'GitHub', link: 'https://github.com/MrityunjayBhardwaj/SonicPi.js' },
    ],

    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Getting Started', link: '/getting-started' },
          { text: 'Architecture', link: '/architecture' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'DSL Reference', link: '/dsl-reference' },
          { text: 'API Reference', link: '/api' },
        ],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/MrityunjayBhardwaj/SonicPi.js' },
    ],

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Based on Sonic Pi by Sam Aaron.',
    },

    search: { provider: 'local' },
  },
})
