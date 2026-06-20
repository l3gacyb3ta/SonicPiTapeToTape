// Client-only. Adds a Run/Stop control to every Ruby code block and plays it
// through one shared SonicPiEngine instance (one AudioContext / scsynth for the
// whole page). The engine is the project's own browser engine, imported lazily
// on the first Run so the docs stay fast and SSR-safe.

type Engine = {
  init(): Promise<void>
  evaluate(code: string): Promise<{ error?: Error }>
  play(): void
  stop(): void
  hasAudio?: boolean
}

let engine: Engine | null = null
let enginePromise: Promise<Engine> | null = null
let currentBtn: HTMLButtonElement | null = null

async function getEngine(): Promise<Engine> {
  if (engine) return engine
  if (!enginePromise) {
    enginePromise = (async () => {
      // Same engine as the live editor + the @mjayb/sonicpijs package.
      const mod: any = await import('../../../src/engine')
      // SuperSonic (scsynth WASM) is GPL — never bundled. Load the class from
      // the CDN at runtime and hand it to the engine, exactly as the app does.
      let SuperSonicClass: unknown
      try {
        const ss: any = await import(/* @vite-ignore */ 'https://unpkg.com/supersonic-scsynth@0.57.0')
        SuperSonicClass = ss.SuperSonic ?? ss.default
      } catch { /* no audio — engine still runs + logs events */ }
      // Frozen PRNG table (EPIC #531) — served from the docs' own /public so it
      // resolves under the /docs/ base in dev and in production.
      const randStreamUrl = `${import.meta.env.BASE_URL}rand-stream.wav`
      const e: Engine = new mod.SonicPiEngine({
        randStreamUrl,
        ...(SuperSonicClass ? { bridge: { SuperSonicClass } } : {}),
      })
      await e.init()
      // Transpiler (tree-sitter) initializes in parallel and may not be ready
      // the instant init() resolves — esp. in dev where its wasm 404s and it
      // falls back to regex after a timeout. Warm it with a no-op evaluate,
      // retrying until the parser/fallback is live, so the first real Run works.
      for (let i = 0; i < 25; i++) {
        const { error } = await e.evaluate('# warmup')
        if (!error || !/parser not available|still be loading/i.test(error.message)) break
        await new Promise((r) => setTimeout(r, 300))
      }
      engine = e
      if (typeof window !== 'undefined') (window as any).__spwEngine = e
      return e
    })()
  }
  return enginePromise
}

function setState(btn: HTMLButtonElement, state: 'idle' | 'loading' | 'playing' | 'error') {
  btn.dataset.state = state
  const label = btn.querySelector('.spw-label') as HTMLElement | null
  const text = state === 'playing' ? '■ Stop'
    : state === 'loading' ? '… Loading'
    : state === 'error' ? '⚠ Error'
    : '▶ Run'
  if (label) label.textContent = text
}

function stopCurrent() {
  if (engine) engine.stop()
  if (currentBtn) { setState(currentBtn, 'idle'); currentBtn = null }
}

function showError(block: HTMLElement, msg: string) {
  let box = block.querySelector('.spw-error') as HTMLElement | null
  if (!box) {
    box = document.createElement('div')
    box.className = 'spw-error'
    block.appendChild(box)
  }
  box.textContent = msg
  box.style.display = 'block'
}
function clearError(block: HTMLElement) {
  const box = block.querySelector('.spw-error') as HTMLElement | null
  if (box) box.style.display = 'none'
}

async function run(block: HTMLElement, code: string, btn: HTMLButtonElement) {
  stopCurrent()
  clearError(block)
  setState(btn, 'loading')
  try {
    const e = await getEngine()
    const { error } = await e.evaluate(code)
    if (error) { setState(btn, 'error'); showError(block, error.message || String(error)); return }
    e.play()
    currentBtn = btn
    setState(btn, 'playing')
  } catch (err: any) {
    setState(btn, 'error')
    showError(block, err?.message || String(err))
  }
}

function codeOf(block: HTMLElement): string {
  const code = block.querySelector('code')
  // textContent preserves the line text; trim trailing newline noise.
  return (code?.textContent ?? '').replace(/\n$/, '')
}

export function decorateRubyBlocks() {
  injectStyleOnce()
  const blocks = document.querySelectorAll<HTMLElement>(
    'div[class~="language-ruby"]:not([data-spw])',
  )
  blocks.forEach((block) => {
    block.setAttribute('data-spw', '1')
    const code = codeOf(block)
    if (!code.trim()) return

    const bar = document.createElement('div')
    bar.className = 'spw-bar'

    const btn = document.createElement('button')
    btn.className = 'spw-btn'
    btn.type = 'button'
    btn.innerHTML = '<span class="spw-label">▶ Run</span>'
    setState(btn, 'idle')
    btn.addEventListener('click', () => {
      if (btn.dataset.state === 'playing') stopCurrent()
      else run(block, code, btn)
    })

    bar.appendChild(btn)
    block.appendChild(bar)
    block.classList.add('spw-block')
  })
}

let styled = false
function injectStyleOnce() {
  if (styled) return
  styled = true
  const css = `
  .spw-block { position: relative; }
  .spw-bar { display: flex; gap: 8px; margin-top: 6px; }
  .spw-btn {
    font: 600 12px/1 var(--vp-font-family-mono, monospace);
    color: var(--vp-c-brand-1, #3451b2);
    background: var(--vp-c-bg-soft, #f6f6f7);
    border: 1px solid var(--vp-c-border, #d1d5db);
    border-radius: 6px; padding: 6px 12px; cursor: pointer;
    transition: background .15s, color .15s, border-color .15s;
  }
  .spw-btn:hover { border-color: var(--vp-c-brand-1, #3451b2); }
  .spw-btn[data-state="playing"] {
    color: #fff; background: var(--vp-c-brand-1, #3451b2);
    border-color: var(--vp-c-brand-1, #3451b2);
  }
  .spw-btn[data-state="loading"] { opacity: .7; cursor: progress; }
  .spw-btn[data-state="error"] { color: var(--vp-c-danger-1, #d33); border-color: var(--vp-c-danger-1, #d33); }
  .spw-error {
    display: none; margin-top: 6px; padding: 8px 12px;
    font: 12px/1.5 var(--vp-font-family-mono, monospace);
    color: var(--vp-c-danger-1, #d33);
    background: var(--vp-c-danger-soft, #fff0f0);
    border-radius: 6px;
  }`
  const el = document.createElement('style')
  el.id = 'spw-style'
  el.textContent = css
  document.head.appendChild(el)
}
