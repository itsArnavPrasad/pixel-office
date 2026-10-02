// Loads the built webview (dist/webview.js + media/office.css) in headless Chrome with a fake VS Code API
// and a realistic office, then screenshots it and fails on any page error.
//   node test/webview-harness.mjs <outdir>
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = resolve(process.argv[2] ?? 'test/out')
mkdirSync(out, { recursive: true })
const here = resolve('.')
const NOW = Date.now()
const T0 = NOW - 600_000
const agent = (id, name, character, state, bubble, over = {}) => ({
  v: 1, id, name, cwd: `/Users/dev/code/${name}`, character, state, bubble, isBusy: state !== 'idle', joinedAt: T0 + id.length,
  since: NOW - 4000, heartbeat: NOW, turns: 7, tools: 52, interns: 0, lastLine: '', pid: 0, files: [], isAway: false, isMe: false, ...over,
})
const seats = [
  agent('a-first', 'first', 'dev-1', 'typing', '$ npm test -- login.spec.ts', { files: ['/Users/dev/code/shared/src/auth.ts'] }),
  agent('b-web', 'web-app', 'dev-2', 'needs-you', 'Allow Bash: rm -rf dist?', { since: NOW - 134_000 }),
  agent('c-api', 'api', 'dev-3', 'reading', 'auth.controller.ts', { interns: 2, files: ['/Users/dev/code/shared/src/auth.ts'] }),
  agent('d-infra', 'infra', 'dev-4', 'writing', '✏️ main.tf'),
  agent('e-docs', 'docs', 'dev-5', 'idle', '', { since: NOW - 300_000 }),
  agent('f-ml', 'ml-train', 'dev-6', 'done', 'Loss is down to 0.12.'),
]
const insights = {
  'c-api': {
    where: 'api', changes: '+212 −40 · 6 files', tokens: '1.4M',
    lines: [
      { who: 'you', text: 'add refresh token rotation to the auth controller' },
      { who: 'agent', text: "I'll read the controller and the token service first." },
      { who: 'tool', text: 'Read(src/auth.controller.ts)' },
      { who: 'agent', text: 'Refresh tokens now rotate on every use, and the old one is revoked.' },
      { who: 'tool', text: 'Bash(npm test -- auth)' },
      { who: 'agent', text: 'All 48 auth tests pass. Want rate limiting on /login next?' },
    ],
  },
}
const base = { type: 'view', now: NOW, seats, queue: ['b-web'], standup: null, insights, selected: null, isEnabled: true,
  collisions: [{ file: '/Users/dev/code/shared/src/auth.ts', ids: ['a-first', 'c-api'], names: ['first', 'api'] }] }
const standup = {
  request: { v: 1, id: '0000000000000-aaaaaa', by: 'editor', requestedAt: NOW - 40_000 },
  answers: [
    { v: 1, id: 'c-api', name: 'api', character: 'dev-3', done: 'Added JWT refresh rotation + 12 tests.', next: 'Rate limiting on /login.', blocked: '', at: NOW - 30_000 },
    { v: 1, id: 'b-web', name: 'web-app', character: 'dev-2', done: 'Built the settings page.', next: 'Clean dist and redeploy.', blocked: 'Approve rm -rf dist in my window.', at: NOW - 29_000 },
  ],
}
const cases = [
  { name: 'panel-busy', mode: 'full', w: 1100, h: 900, view: base },
  { name: 'panel-dialogue', mode: 'full', w: 1100, h: 1100, view: { ...base, selected: 'c-api' } },
  { name: 'panel-standup', mode: 'full', w: 1100, h: 1000, view: { ...base, standup } },
  { name: 'sidebar', mode: 'mini', w: 340, h: 900, view: base },
  { name: 'empty', mode: 'full', w: 900, h: 420, view: { ...base, seats: [], queue: [], collisions: [], isEnabled: false } },
]

// Dark+ theme variables, as VS Code injects them into webviews
const themeVars = `--vscode-font-family:-apple-system,BlinkMacSystemFont,sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:Menlo,monospace;
--vscode-foreground:#cccccc;--vscode-descriptionForeground:#9d9d9d;--vscode-editor-background:#1e1e1e;--vscode-sideBar-background:#181818;
--vscode-button-background:#0e639c;--vscode-button-foreground:#fff;--vscode-button-hoverBackground:#1177bb;--vscode-button-secondaryBackground:#3a3d41;
--vscode-button-secondaryForeground:#ccc;--vscode-panel-border:#3c3c3c;--vscode-input-background:#2b2b2b;--vscode-input-foreground:#ccc;
--vscode-input-border:#3c3c3c;--vscode-focusBorder:#007fd4;--vscode-editorHoverWidget-background:#252526;--vscode-editorHoverWidget-border:#454545;
--vscode-editorWarning-foreground:#cca700;--vscode-editorError-foreground:#f14c4c;--vscode-textLink-foreground:#3794ff`

let failed = false
for (const c of cases) {
  const page = join(out, `${c.name}.html`)
  writeFileSync(page, `<!doctype html><html style="${themeVars.replace(/\n/g, '')}"><head><meta charset="utf-8">
<link rel="stylesheet" href="${pathToFileURL(join(here, 'media/office.css')).href}"></head>
<body class="vscode-dark mode-${c.mode}"${c.mode === 'mini' ? ' style="width:300px"' : ''}><div id="app"></div>
<script>
  window.__errors = []
  window.onerror = (m) => { document.title = 'ERROR: ' + m }
  window.__posted = []
  window.acquireVsCodeApi = () => ({ postMessage: m => { window.__posted.push(m); if (m.type === 'ready') setTimeout(() => window.postMessage(${JSON.stringify(c.view)}, '*'), 0) } })
</script>
<script src="${pathToFileURL(join(here, 'dist/webview.js')).href}"></script>
<script>setTimeout(() => { const ok = document.querySelector('canvas').width > 0 && !document.title.startsWith('ERROR'); document.title = ok ? 'OK ' + document.querySelector('canvas').width : (document.title || 'ERROR: canvas empty') }, 1200)</script>
</body></html>`)
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  const flags = ['--headless=new', '--hide-scrollbars', '--allow-file-access-from-files', '--virtual-time-budget=3000', `--window-size=${c.w},${c.h}`]
  const dom = execFileSync(chrome, [...flags, '--dump-dom', pathToFileURL(page).href], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  const title = /<title>(.*?)<\/title>/.exec(dom)?.[1] ?? 'no title'
  execFileSync(chrome, [...flags, `--screenshot=${join(out, `${c.name}.png`)}`, pathToFileURL(page).href], { stdio: 'ignore' })
  const ok = title.startsWith('OK')
  failed ||= !ok
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.name}: ${title}`)
}
process.exit(failed ? 1 : 0)
