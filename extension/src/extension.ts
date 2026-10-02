import { execFile } from 'node:child_process'
import { cpSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import * as vscode from 'vscode'

import { alertsDue, formatWait, waitingQueue } from '../../pixel-office/hooks/core/alerts'
import type { AlertMemory } from '../../pixel-office/types'
import { collisions } from './collisions'
import { Insights } from './insights'
import { processTree, shellAncestor } from './jump'
import { uiLeader } from './peers'
import type { FromWebview, Insight, ViewState } from './protocol'
import { addPluginDir, isEnabled, removePluginDir } from './setup'
import { OfficeStore, type Snapshot } from './store'
import { OfficeViews } from './ui/panel'

const ROOT = join(homedir(), '.claude', 'pixel-office')
const MOD_DIR = join(ROOT, 'mod')
const SETTINGS = join(homedir(), '.claude', 'settings.json')
const POLL_MS = 1000
const HEARTBEAT_MS = 3000
const INSIGHTS_MS = 5000

export function activate(context: vscode.ExtensionContext) {
  const store = new OfficeStore(ROOT)
  const insights = new Insights()
  const views = new OfficeViews(context, msg => void onMessage(msg))
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
  context.subscriptions.push(status)

  let snap: Snapshot = { seats: [], standup: null, peers: [] }
  let extras: Record<string, Insight> = {}
  let selected: string | null = null
  let memory: AlertMemory = {}
  let lastSent = ''
  let enabled = readEnabled()

  const config = () => vscode.workspace.getConfiguration('pixelOffice')

  function view(now = Date.now()): ViewState {
    return {
      type: 'view', now, seats: snap.seats, queue: waitingQueue(snap.seats).map(s => s.id), standup: snap.standup,
      collisions: collisions(snap.seats), insights: extras, selected, isEnabled: enabled,
    }
  }

  function publish(force = false) {
    const v = view()
    const key = JSON.stringify({ ...v, now: 0 })
    if (!force && key === lastSent) return
    lastSent = key
    views.post(v)
    renderStatus()
  }

  function renderStatus() {
    const queue = waitingQueue(snap.seats)
    const n = snap.seats.length
    status.text = queue.length ? `$(organization) ${n}  $(bell-dot) ${queue.length}` : `$(organization) ${n}`
    status.backgroundColor = queue.length ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined
    const md = new vscode.MarkdownString(undefined, true)
    md.appendMarkdown(`**Pixel Office**: ${n} agent${n === 1 ? '' : 's'}\n\n`)
    for (const s of snap.seats) {
      const wait = s.state === 'needs-you' ? ` · waiting ${formatWait(Date.now() - s.since)}` : ''
      md.appendText(`${s.state === 'needs-you' ? '❗' : '•'} ${s.name}: ${s.state}${wait}${s.isAway ? ' (away)' : ''}\n`)
    }
    if (!n) md.appendMarkdown(enabled ? 'No Claude Code sessions yet.' : 'Run **Pixel Office: Enable in All Claude Code Sessions** to start.')
    status.tooltip = md
    status.command = queue.length ? 'pixelOffice.nextWaiting' : 'pixelOffice.open'
    status.show()
  }

  async function tick() {
    const now = Date.now()
    snap = await store.read(now)
    alert(now)
    publish()
  }

  function alert(now: number) {
    const due = alertsDue(waitingQueue(snap.seats), memory, now)
    memory = due.memory
    if (uiLeader(snap.peers, now) !== store.id) return
    const c = config()
    for (const s of [...due.fresh, ...due.remind]) {
      if (!c.get<boolean>('notifications', true)) break
      const again = due.remind.includes(s) ? ` (still waiting, ${formatWait(now - s.since)})` : ''
      void vscode.window.showWarningMessage(`❗ ${s.name} needs you${again}: ${s.bubble || 'waiting for you'}`, 'Jump', 'Open Office').then(pick => {
        if (pick === 'Jump') void jump(s.id)
        if (pick === 'Open Office') void openOffice(s.id)
      })
    }
    if ((due.fresh.length || due.remind.length) && c.get<boolean>('sound', true) && process.platform === 'darwin')
      execFile('afplay', [join(context.extensionPath, 'media', 'chime.wav')], () => {})
  }

  async function refreshInsights() {
    extras = await insights.refresh(snap.seats, config().get<boolean>('showTokens', true)).catch(() => extras)
    publish()
  }

  async function openOffice(id?: string) {
    if (id) selected = id
    views.openPanel()
    publish(true)
  }

  /** Focuses the integrated terminal the session runs in; otherwise says where it is. */
  async function jump(id: string) {
    const s = snap.seats.find(x => x.id === id)
    if (!s) return
    if (s.pid) {
      const terminals = new Map<number, vscode.Terminal>()
      for (const t of vscode.window.terminals) {
        const pid = await t.processId
        if (pid) terminals.set(pid, t)
      }
      const shell = shellAncestor(s.pid, new Set(terminals.keys()), await processTree())
      if (shell) {
        terminals.get(shell)!.show()
        return
      }
    }
    const here = vscode.workspace.workspaceFolders?.some(f => s.cwd === f.uri.fsPath || s.cwd.startsWith(f.uri.fsPath + '/'))
    const where = here ? 'a Claude Code tab in this window' : `the window or terminal for ${basename(s.cwd) || 'its folder'}`
    void vscode.window.showInformationMessage(`${s.name} isn't in one of this window's terminals. Look for it in ${where}.`)
  }

  async function onMessage(m: FromWebview) {
    switch (m.type) {
      case 'ready':
        return publish(true)
      case 'select':
        selected = m.id
        return publish(true)
      case 'send': {
        const ok = await store.send(m.id, m.text)
        if (!ok) void vscode.window.showErrorMessage('Pixel Office: that message could not be sent.')
        return
      }
      case 'jump':
        return jump(m.id)
      case 'standup':
        await store.requestStandup('editor')
        return tick()
      case 'enable':
        return vscode.commands.executeCommand('pixelOffice.enable')
    }
  }

  function readEnabled(): boolean {
    return isEnabled(existsSync(SETTINGS) ? readFileSync(SETTINGS, 'utf8') : '', MOD_DIR)
  }

  async function setEnabled(on: boolean) {
    const text = existsSync(SETTINGS) ? readFileSync(SETTINGS, 'utf8') : ''
    const edit = on ? addPluginDir(text, MOD_DIR) : removePluginDir(text, MOD_DIR)
    if ('error' in edit) return void vscode.window.showErrorMessage(`Pixel Office: ${edit.error}`)
    if (on) {
      const ok = await vscode.window.showInformationMessage(
        'Enable Pixel Office in every Claude Code session? This copies the Pixel Office mod to ~/.claude/pixel-office/mod and adds it to CLAUDE_CODE_PLUGIN_DIRS in ~/.claude/settings.json (a backup is kept).',
        { modal: true }, 'Enable',
      )
      if (ok !== 'Enable') return
      rmSync(MOD_DIR, { recursive: true, force: true })
      cpSync(join(context.extensionPath, 'mod'), MOD_DIR, { recursive: true })
    }
    if (edit.changed) {
      mkdirSync(join(homedir(), '.claude'), { recursive: true })
      if (existsSync(SETTINGS)) copyFileSync(SETTINGS, `${SETTINGS}.pixel-office.bak`)
      writeFileSync(`${SETTINGS}.tmp`, edit.text)
      renameSync(`${SETTINGS}.tmp`, SETTINGS)
    }
    enabled = on
    publish(true)
    void vscode.window.showInformationMessage(
      on ? 'Pixel Office is on. New Claude Code sessions join the office (restart open ones to add them).' : 'Pixel Office is off for new Claude Code sessions.',
    )
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('pixelOffice.open', () => openOffice()),
    vscode.commands.registerCommand('pixelOffice.standup', async () => {
      await store.requestStandup('editor')
      await openOffice()
      await tick()
    }),
    vscode.commands.registerCommand('pixelOffice.nextWaiting', async () => {
      const next = waitingQueue(snap.seats)[0]
      if (!next) return void vscode.window.showInformationMessage('Nobody is waiting for you. 🎉')
      await openOffice(next.id)
      await jump(next.id)
    }),
    vscode.commands.registerCommand('pixelOffice.enable', () => setEnabled(true)),
    vscode.commands.registerCommand('pixelOffice.disable', () => setEnabled(false)),
  )

  const timers = [
    setInterval(() => void tick().catch(() => {}), POLL_MS),
    setInterval(() => void store.heartbeat().catch(() => {}), HEARTBEAT_MS),
    setInterval(() => void refreshInsights(), INSIGHTS_MS),
  ]
  context.subscriptions.push({ dispose: () => timers.forEach(clearInterval) }, { dispose: () => void store.leave() })
  void store.heartbeat().then(tick).then(refreshInsights).catch(() => {})
  renderStatus()

  // first run: offer setup once, without nagging
  if (!enabled && !context.globalState.get('pixelOffice.offered')) {
    void context.globalState.update('pixelOffice.offered', true)
    void vscode.window.showInformationMessage('Pixel Office: show your Claude Code sessions as a pixel office?', 'Enable', 'Not now').then(pick => {
      if (pick === 'Enable') void setEnabled(true)
    })
  }
}

export function deactivate() {}
