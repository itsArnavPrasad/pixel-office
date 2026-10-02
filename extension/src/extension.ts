import { execFile } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import * as vscode from 'vscode'

import { alertsDue, formatWait, waitingQueue } from '../../pixel-office/hooks/core/alerts'
import { groupRooms, uniqueName } from '../../pixel-office/hooks/core/rooms'
import { LOOK_IDS } from '../../pixel-office/hooks/core/sprites'
import { branchIn } from './git'
import type { AlertMemory } from '../../pixel-office/types'
import { collisions } from './collisions'
import { Insights } from './insights'
import { processTree, shellAncestor } from './jump'
import { uiLeader } from './peers'
import type { FromWebview, Insight, RoomView, ViewState } from './protocol'
import { addPluginDir, isEnabled, removePluginDir } from './setup'
import { OfficeStore, type Snapshot } from './store'
import { OfficeViews } from './ui/panel'

const ROOT = join(homedir(), '.claude', 'pixel-office')
const MOD_DIR = join(ROOT, 'mod')
const SETTINGS = join(homedir(), '.claude', 'settings.json')
const POLL_MS = 1000
const HEARTBEAT_MS = 3000
const INSIGHTS_MS = 5000
const CHAT_MS = 1000

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
  const branches = new Map<string, string>()
  let enabled = readEnabled()

  const config = () => vscode.workspace.getConfiguration('pixelOffice')
  /** Tells the mods whether this window will be seen: only a focused, notifying window replaces their OS notification. */
  const beat = () =>
    store.heartbeat(Date.now(), { isFocused: vscode.window.state.focused, isNotifying: config().get<boolean>('notifications', true) }).catch(() => {})

  function rooms(): RoomView[] {
    return groupRooms(snap.seats).map(r => ({ id: r.id, name: r.name, branch: branches.get(r.id) || undefined, seatIds: r.seats.map(s => s.id), waiting: r.waiting }))
  }

  function view(now = Date.now()): ViewState {
    const chosen = selected && snap.seats.some(s => s.id === selected) ? selected : null
    return {
      type: 'view', now, seats: snap.seats, rooms: rooms(), queue: waitingQueue(snap.seats).map(s => s.id), standup: snap.standup,
      collisions: collisions(snap.seats), insights: extras, selected: chosen,
      chat: chosen ? { id: chosen, ...insights.chat(chosen) } : null, isEnabled: enabled, home: homedir(),
      showCollisions: config().get<boolean>('showCollisionRadar', true),
    }
  }

  function publish(force = false) {
    const v = view()
    // heartbeats tick every second without changing anything shown
    const key = JSON.stringify({ ...v, now: 0, seats: v.seats.map(s => ({ ...s, heartbeat: 0 })) })
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

  let isRefreshing = false
  async function refreshInsights() {
    if (isRefreshing) return // a slow pass (a big first transcript read, slow git) must not overlap the next
    isRefreshing = true
    try {
      extras = await insights.refresh(snap.seats, config().get<boolean>('showTokens', true)).catch(() => extras)
      for (const r of groupRooms(snap.seats)) branches.set(r.id, await branchIn(r.id))
      publish()
    } finally {
      isRefreshing = false
    }
  }

  /** Keeps the open console live between the slower insight refreshes. */
  async function refreshChat() {
    if (!selected || isRefreshing) return
    await insights.refreshOne(selected).catch(() => {})
    publish()
  }

  /** A real room in the office now; anything else from the webview is ignored. */
  const knownRoom = (room: string | null) => (room && groupRooms(snap.seats).some(r => r.id === room) ? room : null)

  /** New agent: a name and an optional task, then a Claude Code tab or a terminal in the room's folder. */
  async function newAgent(room: string | null) {
    const roomList = groupRooms(snap.seats)
    let target = knownRoom(room)
    if (!target) {
      const folders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath)
      const picks = [...new Set([...roomList.map(r => r.id), ...folders])]
      if (!picks.length) return void vscode.window.showInformationMessage('Open a folder first: a new agent starts in a repository.')
      const pick = picks.length === 1 ? picks[0] : await vscode.window.showQuickPick(picks.map(p => ({ label: basename(p), description: p, p })), { title: 'New agent: which room?' }).then(x => x?.p)
      if (!pick) return
      target = pick
    }
    const taken = snap.seats.filter(s => s.room === target).map(s => s.name)
    const name = await vscode.window.showInputBox({ title: `New agent in ${basename(target)}`, prompt: 'Its name in the office', value: uniqueName(`${basename(target)}-agent`, taken), validateInput: v => (v.trim() && v.length <= 40 ? undefined : '1–40 characters') })
    if (!name) return
    const task = await vscode.window.showInputBox({ title: `New agent: ${name}`, prompt: 'What should it work on? (optional, becomes its first prompt)', placeHolder: 'e.g. write tests for the auth controller' })
    if (task === undefined) return
    const here = (vscode.workspace.workspaceFolders ?? []).some(f => target === f.uri.fsPath || target!.startsWith(f.uri.fsPath + '/') || f.uri.fsPath.startsWith(target + '/'))
    const options = [...(here ? ['Claude Code tab'] : []), 'Terminal (claude CLI)']
    const how = options.length === 1 ? options[0] : await vscode.window.showQuickPick(options, { title: `Start ${name} in…` })
    if (!how) return
    const character = LOOK_IDS[Math.floor(Math.random() * LOOK_IDS.length)]!
    await store.spawn(target, name.trim(), task.trim(), character)
    if (how === 'Claude Code tab') {
      await vscode.commands.executeCommand('claude-vscode.editor.open').then(undefined, () =>
        vscode.window.showErrorMessage('Could not open a Claude Code tab: is the Claude Code extension installed?'),
      )
    } else {
      const term = vscode.window.createTerminal({ name: `claude · ${name.trim()}`, cwd: target })
      term.show()
      term.sendText('claude')
    }
    void vscode.window.showInformationMessage(`${name.trim()} is on the way to ${basename(target)}. It takes its desk when its session starts.`)
  }

  async function openTranscript(id: string) {
    const path = insights.transcriptPath(id)
    if (!path) return void vscode.window.showInformationMessage('No transcript yet: it appears after the first turn.')
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(path), { preview: true })
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
        if (m.id) await insights.refreshOne(m.id).catch(() => {})
        return publish(true)
      case 'openPanel':
        return openOffice(m.id ?? undefined)
      case 'openTranscript':
        return openTranscript(m.id)
      case 'newAgent':
        return newAgent(m.room)
      case 'send': {
        const ok = await store.send(m.id, m.text)
        if (!ok) void vscode.window.showErrorMessage('Pixel Office: that message could not be sent.')
        return
      }
      case 'jump':
        return jump(m.id)
      case 'standup':
        await store.requestStandup('editor', knownRoom(m.room))
        return tick()
      case 'enable':
        return vscode.commands.executeCommand('pixelOffice.enable')
      case 'hideCollisions': {
        // a setting, so it holds in every window and can be turned back on in Settings
        await config().update('showCollisionRadar', false, vscode.ConfigurationTarget.Global)
        publish(true)
        const pick = await vscode.window.showInformationMessage('Collision radar banner hidden. Turn it back on any time in Settings.', 'Undo')
        if (pick === 'Undo') await config().update('showCollisionRadar', true, vscode.ConfigurationTarget.Global)
        return publish(true)
      }
    }
  }

  function readEnabled(): boolean {
    return isEnabled(existsSync(SETTINGS) ? readFileSync(SETTINGS, 'utf8') : '', MOD_DIR)
  }

  async function setEnabled(on: boolean) {
    const read = () => (existsSync(SETTINGS) ? readFileSync(SETTINGS, 'utf8') : '')
    // check first, so a broken settings.json is reported before asking anything
    const probe = on ? addPluginDir(read(), MOD_DIR) : removePluginDir(read(), MOD_DIR)
    if ('error' in probe) return void vscode.window.showErrorMessage(`Pixel Office: ${probe.error}`)
    if (on) {
      const ok = await vscode.window.showInformationMessage(
        'Enable Pixel Office in every Claude Code session? This copies the Pixel Office mod to ~/.claude/pixel-office/mod and adds it to CLAUDE_CODE_PLUGIN_DIRS in ~/.claude/settings.json (a backup is kept).',
        { modal: true }, 'Enable',
      )
      if (ok !== 'Enable') return
      rmSync(MOD_DIR, { recursive: true, force: true })
      cpSync(join(context.extensionPath, 'mod'), MOD_DIR, { recursive: true })
      writeFileSync(join(MOD_DIR, '.pixel-office-version'), String(context.extension?.packageJSON?.version ?? ''))
    }
    // computed again after the dialog, so an edit made meanwhile is kept; a value set in the shell
    // is carried in, since the settings env would otherwise replace it
    const shellDirs = process.env.CLAUDE_CODE_PLUGIN_DIRS
    const edit = on ? addPluginDir(read(), MOD_DIR, shellDirs) : removePluginDir(read(), MOD_DIR)
    if ('error' in edit) return void vscode.window.showErrorMessage(`Pixel Office: ${edit.error}`)
    if (edit.changed) {
      mkdirSync(join(homedir(), '.claude'), { recursive: true })
      // a dotfile manager's symlink is followed, not replaced by a plain file
      const target = existsSync(SETTINGS) ? realpathSync(SETTINGS) : SETTINGS
      if (existsSync(target)) copyFileSync(target, `${SETTINGS}.pixel-office.bak`)
      writeFileSync(`${target}.pixel-office.tmp`, edit.text)
      renameSync(`${target}.pixel-office.tmp`, target)
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
    vscode.commands.registerCommand('pixelOffice.newAgent', () => newAgent(null)),
    vscode.commands.registerCommand('pixelOffice.enable', () => setEnabled(true)),
    vscode.commands.registerCommand('pixelOffice.disable', () => setEnabled(false)),
  )

  const timers = [
    setInterval(() => void tick().catch(() => {}), POLL_MS),
    setInterval(() => void beat(), HEARTBEAT_MS),
    setInterval(() => void refreshInsights(), INSIGHTS_MS),
    setInterval(() => void refreshChat(), CHAT_MS),
  ]
  context.subscriptions.push({ dispose: () => timers.forEach(clearInterval) }, { dispose: () => void store.leave() })
  void beat().then(tick).then(refreshInsights).catch(() => {})
  context.subscriptions.push(vscode.window.onDidChangeWindowState(() => void beat()))
  renderStatus()

  // an update ships a newer mod: refresh the installed copy, so new sessions run it
  const version = String(context.extension?.packageJSON?.version ?? '')
  const stamp = join(MOD_DIR, '.pixel-office-version')
  if (enabled && version && (existsSync(stamp) ? readFileSync(stamp, 'utf8') : '') !== version) {
    try {
      rmSync(MOD_DIR, { recursive: true, force: true })
      cpSync(join(context.extensionPath, 'mod'), MOD_DIR, { recursive: true })
      writeFileSync(stamp, version)
    } catch (err) {
      void vscode.window.showErrorMessage(`Pixel Office: could not update the mod (${(err as Error).message}).`)
    }
  }

  // first run: offer setup once, without nagging
  if (!enabled && !context.globalState.get('pixelOffice.offered')) {
    void context.globalState.update('pixelOffice.offered', true)
    void vscode.window.showInformationMessage('Pixel Office: show your Claude Code sessions as a pixel office?', 'Enable', 'Not now').then(pick => {
      if (pick === 'Enable') void setEnabled(true)
    })
  }
}

export function deactivate() {}
