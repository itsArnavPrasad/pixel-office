// Runs the real bundle (dist/extension.js) against a fake `vscode` and a temporary HOME:
// activation, status bar, a waiting agent's notification, enable/disable, standup and messages.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')
const { test } = require('node:test')

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-home-'))
process.env.HOME = HOME
const ROOT = path.join(HOME, '.claude', 'pixel-office')
const EXT = path.resolve(__dirname, '..')

const calls = { info: [], warn: [], error: [], commands: new Map(), executed: [] }
let modalAnswer = 'Enable'
const status = { text: '', show() {}, dispose() {} }
const vscode = {
  StatusBarAlignment: { Left: 1 },
  ViewColumn: { Active: -1 },
  ThemeColor: class { constructor(id) { this.id = id } },
  MarkdownString: class { constructor() { this.value = '' } appendMarkdown(s) { this.value += s } appendText(s) { this.value += s } },
  Uri: { joinPath: (u, ...p) => ({ fsPath: path.join(u.fsPath, ...p) }) },
  window: {
    terminals: [],
    createStatusBarItem: () => status,
    registerWebviewViewProvider: () => ({ dispose() {} }),
    createWebviewPanel: () => ({ webview: { postMessage() {}, onDidReceiveMessage() {}, asWebviewUri: u => u, cspSource: 'x' }, reveal() {}, onDidDispose() {} }),
    showInformationMessage: (msg, ...rest) => (calls.info.push(msg), Promise.resolve(rest[0]?.modal ? modalAnswer : undefined)),
    showWarningMessage: msg => (calls.warn.push(msg), Promise.resolve(undefined)),
    showErrorMessage: msg => (calls.error.push(msg), Promise.resolve(undefined)),
  },
  workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (_k, d) => (_k === 'sound' ? false : d) }) },
  commands: {
    registerCommand: (id, fn) => (calls.commands.set(id, fn), { dispose() {} }),
    executeCommand: (id, ...a) => (calls.executed.push(id), calls.commands.get(id)?.(...a)),
  },
}
const load = Module._load
Module._load = function (request, ...rest) {
  return request === 'vscode' ? vscode : load.call(this, request, ...rest)
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
const agent = (id, over = {}) => ({
  v: 1, id, name: id, cwd: '/tmp', character: 'dev-1', state: 'idle', bubble: '', isBusy: false, joinedAt: Date.now(),
  since: Date.now(), heartbeat: Date.now(), turns: 0, tools: 0, interns: 0, lastLine: '', pid: 0, files: [], ...over,
})
const put = rec => {
  fs.mkdirSync(path.join(ROOT, 'agents'), { recursive: true })
  fs.writeFileSync(path.join(ROOT, 'agents', `${rec.id}.json`), JSON.stringify(rec))
}

test('the built extension activates and runs the office end to end', { timeout: 30_000 }, async () => {
  const ext = require(path.join(EXT, 'dist', 'extension.js'))
  const subscriptions = []
  const state = new Map()
  ext.activate({
    subscriptions, extensionPath: EXT, extensionUri: { fsPath: EXT },
    globalState: { get: k => state.get(k), update: (k, v) => (state.set(k, v), Promise.resolve()) },
  })

  // commands are registered, and the first-run offer appears once
  for (const c of ['pixelOffice.open', 'pixelOffice.nextWaiting', 'pixelOffice.standup', 'pixelOffice.enable', 'pixelOffice.disable'])
    assert.ok(calls.commands.has(c), c)
  assert.ok(calls.info.some(m => m.includes('show your Claude Code sessions')))

  // this window announces itself
  await sleep(500)
  assert.equal(fs.readdirSync(path.join(ROOT, 'ui')).filter(n => n.endsWith('.json')).length, 1)

  // two agents walk in; one starts waiting → status bar + one notification
  put(agent('web', { state: 'needs-you', bubble: 'Allow Bash: rm -rf dist?' }))
  put(agent('api', { state: 'typing', bubble: '$ npm test' }))
  await sleep(2300)
  assert.match(status.text, /organization\) 2/)
  assert.match(status.text, /bell-dot\) 1/)
  assert.equal(calls.warn.filter(m => m.includes('web needs you')).length, 1)
  await sleep(1200)
  assert.equal(calls.warn.filter(m => m.includes('web needs you')).length, 1, 'no repeat')

  // enable: settings.json gets the mod dir, the mod is copied; disable undoes it
  await calls.commands.get('pixelOffice.enable')()
  const settings = JSON.parse(fs.readFileSync(path.join(HOME, '.claude', 'settings.json'), 'utf8'))
  assert.equal(settings.env.CLAUDE_CODE_PLUGIN_DIRS, path.join(ROOT, 'mod'))
  assert.ok(fs.existsSync(path.join(ROOT, 'mod', 'hooks', 'register.tsx')))
  assert.ok(fs.existsSync(path.join(ROOT, 'mod', '.claude-plugin', 'plugin.json')))
  await calls.commands.get('pixelOffice.disable')()
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(HOME, '.claude', 'settings.json'), 'utf8')), {})

  // declining the confirmation changes nothing
  modalAnswer = undefined
  await calls.commands.get('pixelOffice.enable')()
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(HOME, '.claude', 'settings.json'), 'utf8')), {})

  // standup writes a request
  await calls.commands.get('pixelOffice.standup')()
  assert.equal(fs.readdirSync(path.join(ROOT, 'standup')).filter(n => n.endsWith('.json')).length, 1)

  // next waiting with nobody in a terminal says where to look
  await calls.commands.get('pixelOffice.nextWaiting')()
  assert.ok(calls.info.some(m => m.includes("web isn't in one of this window's terminals")))

  assert.deepEqual(calls.error, [])
  for (const s of subscriptions) s.dispose?.()
  await sleep(100)
  assert.equal(fs.readdirSync(path.join(ROOT, 'ui')).filter(n => n.endsWith('.json')).length, 0, 'heartbeat removed on dispose')
  fs.rmSync(HOME, { recursive: true, force: true })
})
