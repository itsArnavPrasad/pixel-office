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
  v: 1, id, name, cwd: '/Users/dev/code/web-app', character, state, bubble, detail: '', isBusy: state !== 'idle', joinedAt: T0 + id.length,
  since: NOW - 4000, heartbeat: NOW, turns: 7, tools: 52, interns: 0, lastLine: '', pid: 0, files: [], isAway: false, isMe: false,
  room: '/Users/dev/code/web-app', roomName: 'web-app', ...over,
})
const API = { cwd: '/Users/dev/code/api', room: '/Users/dev/code/api', roomName: 'api' }
const seats = [
  agent('a-ui', 'ui-polish', 'dev-1', 'typing', 'Running tests', { detail: '$ npm test -- Settings.spec.tsx', files: ['/Users/dev/code/web-app/src/auth.ts', '/Users/dev/code/web-app/src/Settings.tsx'] }),
  agent('b-deploy', 'deploy', 'dev-2', 'needs-you', 'Allow Bash: rm -rf dist?', { since: NOW - 134_000 }),
  agent('c-auth', 'auth', 'dev-3', 'writing', 'Editing auth.ts', { interns: 2, detail: '/Users/dev/code/web-app/src/auth.ts', files: ['/Users/dev/code/web-app/src/auth.ts'] }),
  agent('d-docs', 'docs', 'dev-5', 'idle', '', { since: NOW - 300_000 }),
  agent('e-api', 'api', 'dev-4', 'reading', 'Reading routes.ts', { ...API }),
  agent('f-db', 'migrations', 'dev-6', 'done', 'Migration 042 applied.', { ...API }),
]
const rooms = [
  { id: '/Users/dev/code/web-app', name: 'web-app', branch: 'feature/settings', seatIds: ['a-ui', 'b-deploy', 'c-auth', 'd-docs'], waiting: 1 },
  { id: '/Users/dev/code/api', name: 'api', branch: 'main', seatIds: ['e-api', 'f-db'], waiting: 0 },
]
const insights = {
  'c-auth': { where: 'web-app', changes: '+212 −40 · 6 files', tokens: '84k new · 1.4M cached', hasTranscript: true },
  'a-ui': { changes: '+30 −4 · 2 files', tokens: '12k new · 300k cached', hasTranscript: true },
}
const at = s => NOW - s * 1000
const entries = [
  { kind: 'you', text: 'add refresh token rotation to the auth controller, and make sure the old token is revoked', at: at(600) },
  { kind: 'agent', text: "I'll read the controller and the token service first, then write the rotation with tests.", at: at(590) },
  { kind: 'tool', tool: 'Read', text: '/Users/dev/code/web-app/src/auth.ts', input: '{\n  "file_path": "/Users/dev/code/web-app/src/auth.ts"\n}', output: 'export async function refresh(token: string) { … }', at: at(588), callId: 't1' },
  { kind: 'tool', tool: 'Grep', text: 'revoke', input: '{ "pattern": "revoke" }', output: 'src/tokens.ts:41', at: at(586), callId: 't2' },
  { kind: 'tool', tool: 'TodoWrite', text: '', input: '{}', output: 'ok', at: at(585), callId: 't3' },
  { kind: 'agent', text: 'The service already has `revoke(id)`. Plan:\n1. rotate on every `refresh()`\n2. revoke the old token\n3. tests', at: at(560) },
  { kind: 'tool', tool: 'Edit', text: '/Users/dev/code/web-app/src/auth.ts', input: '{ "file_path": "src/auth.ts", "old_string": "…", "new_string": "…" }', output: 'Updated', at: at(540), callId: 't4' },
  { kind: 'tool', tool: 'Bash', text: 'npm test -- auth', input: '{ "command": "npm test -- auth" }', output: 'FAIL src/auth.spec.ts\n  ✕ revokes the previous token (12 ms)\n    Expected: "revoked"\n    Received: "active"', isError: true, at: at(520), callId: 't5' },
  { kind: 'agent', text: 'One test fails: the old token is revoked **after** the response is sent. Moving `revoke()` before `res.send()`:\n```ts\nawait tokens.revoke(old.id)\nres.send({ token })\n```', at: at(500) },
  { kind: 'tool', tool: 'Edit', text: '/Users/dev/code/web-app/src/auth.ts', input: '{ "file_path": "src/auth.ts" }', output: 'Updated', at: at(480), callId: 't6' },
  { kind: 'tool', tool: 'Bash', text: 'npm test -- auth', input: '{ "command": "npm test -- auth" }', output: 'PASS src/auth.spec.ts (48 tests)', at: at(470), callId: 't7' },
  { kind: 'agent', text: 'All 48 auth tests pass. Refresh tokens now rotate on every use and the old one is revoked first. Want rate limiting on `/login` next?', at: at(460) },
  { kind: 'you', text: 'yes, add rate limiting to /login: 5 tries per minute per IP', at: at(30) },
  { kind: 'tool', tool: 'Edit', text: '/Users/dev/code/web-app/src/middleware/rate-limit.ts', input: '{}', at: at(5), callId: 't8' },
]
const plan = [
  { text: 'Rotate refresh tokens on every use', status: 'completed' },
  { text: 'Revoke the previous token before responding', status: 'completed' },
  { text: 'Tests for rotation and revocation', status: 'completed' },
  { text: 'Rate limit /login to 5/min per IP', status: 'in_progress' },
  { text: 'Tests for the rate limiter', status: 'pending' },
]
const base = { type: 'view', now: NOW, seats, rooms, queue: ['b-deploy'], standup: null, insights, selected: null, chat: null, isEnabled: true, home: '/Users/dev',
  collisions: [{ file: '/Users/dev/code/web-app/src/auth.ts', ids: ['a-ui', 'c-auth'], names: ['ui-polish', 'auth'] }] }
const chat = { id: 'c-auth', entries, task: 'yes, add rate limiting to /login: 5 tries per minute per IP', plan }
const standup = {
  request: { v: 1, id: '0000000000000-aaaaaa', by: 'editor', requestedAt: NOW - 40_000, room: '/Users/dev/code/web-app' },
  answers: [
    { v: 1, id: 'c-auth', name: 'auth', character: 'dev-3', done: 'Refresh rotation + revocation, 48 tests green.', next: 'Rate limiting on /login.', blocked: '', at: NOW - 30_000 },
    { v: 1, id: 'b-deploy', name: 'deploy', character: 'dev-2', done: 'Built the release bundle.', next: 'Clean dist and redeploy.', blocked: 'Approve rm -rf dist in my window.', at: NOW - 29_000 },
  ],
}
const cases = [
  { name: 'panel-rooms', mode: 'full', w: 1100, h: 1000, view: base },
  { name: 'panel-console', mode: 'full', w: 1500, h: 1100, view: { ...base, selected: 'c-auth', chat } },
  { name: 'panel-everything', mode: 'full', w: 1500, h: 1100, view: { ...base, selected: 'c-auth', chat }, filter: 'everything' },
  { name: 'panel-standup', mode: 'full', w: 1100, h: 1100, view: { ...base, standup } },
  { name: 'sidebar', mode: 'mini', w: 340, h: 1000, view: base },
  { name: 'empty', mode: 'full', w: 900, h: 420, view: { ...base, seats: [], rooms: [], queue: [], collisions: [], isEnabled: false } },
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
  window.acquireVsCodeApi = () => ({ getState: () => (${JSON.stringify(c.filter ? { filter: c.filter } : null)}), setState() {}, postMessage: m => { window.__posted.push(m); if (m.type === 'ready') setTimeout(() => window.postMessage(${JSON.stringify(c.view)}, '*'), 0) } })
</script>
<script src="${pathToFileURL(join(here, 'dist/webview.js')).href}"></script>
<script>setTimeout(() => { const cv = document.querySelector('canvas'); const ok = (!cv || cv.width > 0) && !document.title.startsWith('ERROR') && document.querySelector('header.top'); document.title = ok ? 'OK ' + (cv ? cv.width : 'no rooms') : (document.title || 'ERROR: nothing drawn') }, 1200)</script>
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
