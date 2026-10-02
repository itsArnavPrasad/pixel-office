// The office folder as the extension sees it: read every second, written for messages,
// standups and this window's heartbeat. No vscode import, so it is tested over a real folder.
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { SpawnTicket, Standup, StandupAnswer } from '../../pixel-office/types'
import { makeMessage, messageId } from '../../pixel-office/hooks/core/inbox'
import { mergeRoster, parseRecord, type Seat } from '../../pixel-office/hooks/core/roster'
import { SHOW_MS, latestRequest, makeRequest, parseAnswer, parseRequest } from '../../pixel-office/hooks/core/standup'
import { parsePeer, type Peer } from './peers'

export type Snapshot = { seats: Seat[]; standup: Standup | null; peers: Peer[] }

const MAX_AGENTS = 64
const PEER_STALE_MS = 60_000
const ID = /^[A-Za-z0-9._-]{1,100}$/

async function readText(path: string): Promise<string> {
  return readFile(path, 'utf8').catch(() => '')
}

async function names(dir: string): Promise<string[]> {
  return readdir(dir).catch(() => [])
}

/** Writes via a temp file and rename, so a reader never sees half a file. */
async function writeAtomic(path: string, text: string) {
  const dir = path.slice(0, path.lastIndexOf('/'))
  await mkdir(dir, { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, text)
  await rename(tmp, path)
}

export class OfficeStore {
  readonly root: string
  readonly id: string
  private readonly startedAt: number

  constructor(root: string, now = Date.now(), id = `w-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`) {
    this.root = root
    this.id = id
    this.startedAt = now
  }

  async read(now = Date.now()): Promise<Snapshot> {
    const dir = join(this.root, 'agents')
    const records = []
    for (const name of (await names(dir)).filter(n => n.endsWith('.json')).slice(0, MAX_AGENTS)) {
      const rec = parseRecord(await readText(join(dir, name)))
      if (rec && `${rec.id}.json` === name) records.push(rec)
    }
    const seats = mergeRoster(records, null, now)

    const peers: Peer[] = []
    for (const name of (await names(join(this.root, 'ui'))).filter(n => n.endsWith('.json'))) {
      const p = parsePeer(await readText(join(this.root, 'ui', name)))
      if (p && `${p.id}.json` === name) peers.push(p)
    }
    return { seats, standup: await this.readStandup(now), peers }
  }

  private async readStandup(now: number): Promise<Standup | null> {
    const dir = join(this.root, 'standup')
    const id = latestRequest(await names(dir), now, SHOW_MS)
    if (!id) return null
    const request = parseRequest(await readText(join(dir, `${id}.json`)))
    if (!request) return null
    const answers: StandupAnswer[] = []
    for (const name of await names(join(dir, id))) {
      const a = parseAnswer(await readText(join(dir, id, name)))
      if (a && `${a.id}.json` === name) answers.push(a)
    }
    return { request, answers: answers.sort((a, b) => a.at - b.at) }
  }

  /** Announces this window, which also tells the mods an editor is handling alerts. */
  async heartbeat(now = Date.now(), flags: { isFocused: boolean; isNotifying: boolean } = { isFocused: true, isNotifying: true }) {
    const peer: Peer = { v: 1, id: this.id, startedAt: this.startedAt, heartbeat: now, ...flags }
    await writeAtomic(join(this.root, 'ui', `${this.id}.json`), JSON.stringify(peer))
    await this.sweepPeers(now)
  }

  /** Window files a crash or quit left behind (the async leave() rarely finishes on quit). */
  private async sweepPeers(now: number) {
    for (const name of await names(join(this.root, 'ui'))) {
      if (name === `${this.id}.json`) continue
      const path = join(this.root, 'ui', name)
      const age = now - (await stat(path).then(s => s.mtimeMs, () => now))
      if (age > PEER_STALE_MS) await rm(path, { force: true })
    }
  }

  async send(to: string, text: string, now = Date.now()): Promise<boolean> {
    if (!ID.test(to)) return false
    const m = makeMessage('you', 'you', text, now, Math.random())
    if (!m) return false
    await writeAtomic(join(this.root, 'inbox', to, `${m.id}.json`), JSON.stringify(m))
    return true
  }

  /** A standup for one room (only its sessions answer), or for everyone with `room` null. */
  async requestStandup(by: string, room: string | null = null, now = Date.now()): Promise<string> {
    const id = messageId(now, Math.random())
    const request = room ? { ...makeRequest(id, by, now), room } : makeRequest(id, by, now)
    await writeAtomic(join(this.root, 'standup', `${id}.json`), JSON.stringify(request))
    return id
  }

  /** Asks the next Claude session that starts in `room` to take this name and task. */
  async spawn(room: string, name: string, task: string, character: string, now = Date.now()): Promise<SpawnTicket> {
    const ticket: SpawnTicket = { v: 1, id: messageId(now, Math.random()), room, name: name.slice(0, 40), task: task.slice(0, 4000), character, createdAt: now }
    await writeAtomic(join(this.root, 'spawn', `${ticket.id}.json`), JSON.stringify(ticket))
    return ticket
  }

  /** Removes this window's heartbeat when it closes. */
  async leave() {
    await rm(join(this.root, 'ui', `${this.id}.json`), { force: true })
  }

  async exists(): Promise<boolean> {
    return stat(this.root).then(() => true, () => false)
  }
}
