# Pixel Office — build plan

A Claude Code mod that shows every running Claude Code session as a pixel-art
character in a small 2D office. Each character acts out what its session is
doing, says things in speech bubbles, raises its hand when it needs you, and
can be clicked to open a dialogue box and talk to it.

Working name: `pixel-office` (rename any time — one string in `plugin.json`).

---

## 1. What we are building (the experience)

Open `/office` (or it opens itself on a wide terminal) and you see:

```
┌ Pixel Office ─────────────────────────────────────────────┐
│  ▓▓ window ▓▓      [plant]        ▓▓ window ▓▓    ☕       │
│   ┌──┐  ...typing    ┌──┐ ❗          ┌──┐  zzz            │
│   │🧑│ "Running tests" │👩│ "Can I run  │🧔│                 │
│   └──┘  desk A       └──┘  rm -rf?"   └──┘  desk C        │
│        interns: 🐣🐣                                       │
├───────────────────────────────────────────────────────────┤
│ [1 api-server ● working] [2 web ❗ needs you] [3 docs ○ idle]│
└───────────────────────────────────────────────────────────┘
```

Click a character (terminal), or its name chip, or press `1`–`9`. A dialogue
box opens in RPG style, showing their last lines as typewriter text, with an
input for your reply. Your message is delivered to that session as a prompt.

### Behaviour each character acts out (state machine)

| Session signal (hook) | Character state | Animation | Bubble |
|---|---|---|---|
| `session.start` | `arriving` → `idle` | walks in from the door to a free desk | "Morning!" |
| `prompt.submit` | `thinking` | sits, thought dots `...` | your prompt's first words |
| `tool.call` Bash | `typing` | fast typing, monitor scrolls green | `$ npm test` (truncated) |
| `tool.call` Read / Grep / Glob | `reading` | flips a book | file name |
| `tool.call` Edit / Write / NotebookEdit | `writing` | scribbling, paper bits | file name |
| `tool.call` WebSearch / WebFetch | `browsing` | walks to the library shelf | query / host |
| `tool.call` Agent / subagent spawn | `delegating` | intern sprite pops up beside desk | subagent description |
| `tool.call` AskUserQuestion, `classic.PermissionRequest`, `classic.Notification` | `needs-you` | stands, hand up, blinking ❗, chime | the question / command |
| tool result `isError` | `stressed` (3 s) | sweat drop / smoke puff | "Hmm, that failed" |
| `turn.complete` | `done` (3 s) → `idle` | stretches | first sentence of the final answer |
| no events for 60 s | `idle` | coffee machine / looking around | — |
| no heartbeat for 20 s | `away` | ghosted at desk (dimmed) | — |
| `session.end` | `leaving` | walks out, desk freed | "Bye!" |

Priority when signals overlap: `needs-you` > `stressed` > working states >
`done` > `idle`. `needs-you` clears on the next `tool.call` result, prompt
submit or turn complete.

---

## 2. Architecture

### 2.1 The constraint that shapes everything
A mod runs **inside one session**. There is no built-in "all sessions" view, so
every session runs the same mod and they share state through a folder.

```
 Session A (mod)          Session B (mod)          Session C (mod)
  hooks → own state        hooks → own state        hooks → own state
     │ write                  │                        │
     ▼                        ▼                        ▼
 ~/.claude/pixel-office/
   agents/<sessionId>.json   presence + state, heartbeat every 2 s
   inbox/<sessionId>/<ts>-<rand>.json   messages to that session
   theme.json                user customization (optional)
   packs/<name>.json         sprite packs (optional)
     ▲
     └─ every session polls agents/*.json (1 s) → whole office → draws it
        each session polls only its own inbox → $.prompt.submit(text)
```

There is no central server and no daemon: nothing to install and nothing that
can crash and take the others with it. If a session dies, its file goes stale
and its character shows as `away`, then gets pruned.

### 2.2 Layers (pure core, thin shell)
Test files run with **no fs, network or process**, so all logic lives in pure
modules that take data in and return data out. The engine-facing layer stays
thin.

```
hooks/
  register.tsx          wiring only: events → core → $.fs / $.state / $.ui
  core/
    agent.ts            AgentRecord type, state machine (event → next state), priority, timeouts
    signals.ts          map a tool call / classic event → {state, bubble}, truncation, redaction
    roster.ts           merge agents/*.json → roster; stale/away/prune; desk assignment (stable by id hash)
    inbox.ts            message encode/decode/validate, ordering, dedupe by id, cursor
    scene.ts            layout: office size from pane width, desk slots, door, props, walk paths
    anim.ts             per-character animation timeline (frame index from state + clock)
    pixels.ts           Frame buffer (Uint32 RGBA), blit sprite, draw text bubble glyphs, compositing
    sprites.ts          built-in sprite sheets as string art + palette; pack loader & validator
    encode-raster.ts    Frame → Raster cells (half-block ▀, fg = top px, bg = bottom px)
    encode-svg.ts       Frame → compact SVG (one <path> per colour, run-length rows)
    theme.ts            theme.json schema, defaults, validation, merge
    text.ts             speech-bubble wrapping, first-sentence extraction, ANSI/control strip
  ui/
    office-client.tsx   terminal Client module: pointer hit-testing → post({click: id})
```

### 2.3 Rendering per surface (the user is on Cursor/VS Code today)
| Surface | Office scene | Animation | Click a character |
|---|---|---|---|
| terminal | `Raster`, half-block pixels (2 px per cell) | `$.clock.every(125)` → `$.ui.blit` (~8 fps, no re-render) | `Client` overlay with pointer x/y → hit test; plus name chips |
| vscode / desktop | `Svg` (`isInteractive` for CSS sprite animation) | state-driven re-render ≤ 4 fps + CSS keyframes inside the SVG | name-chip `Button`s with hotkeys `1`–`9` |
| mobile | `Svg`, static | re-render on state change | name chips |
| any, if the above is refused | text fallback: Box/Text list of agents with emoji + state | — | chips |

One pixel renderer (`pixels.ts`) feeds every encoder, so all surfaces show the
same office.

### 2.4 Data contracts

`agents/<sessionId>.json` (schema version 1):
```json
{ "v": 1, "id": "…", "name": "api-server", "cwd": "/…/api-server",
  "character": "dev-1", "state": "typing", "bubble": "$ npm test",
  "needsYou": false, "since": 1759400000000, "heartbeat": 1759400002000,
  "turns": 12, "tools": 87, "lastLine": "All 42 tests pass.", "pid": "…" }
```
`inbox/<sessionId>/<ts>-<rand>.json`:
```json
{ "v": 1, "id": "<ts>-<rand>", "from": "<sessionId|you>", "fromName": "web",
  "text": "please also update the README", "sentAt": 1759400003000 }
```
Validate every file read. A malformed or foreign file is skipped and never
crashes the render. Writes are whole-file. Because `$.fs` has no delete,
cleanup goes through `$.process.run(['rm', ...])`, limited to paths under the
office root.

### 2.5 Local state (`$.state`, survives hot reloads)
`roster` (others' records), `me` (own record), `selected` (id open in the
dialogue), `log` (last 20 lines per agent for the dialogue), `prefs`.
`$.store` keeps: chosen name/character per project dir, inbox cursor.

### 2.6 Safety rules
- Message text is never run as anything except a prompt, and only by the
  receiving session's own mod. A message is shown in the dialogue first, and
  `autoDeliver` (default **on** for messages you type into the dialogue) can be
  turned off so incoming messages wait for a click.
- Bubbles strip control/ANSI characters and are truncated to 60 chars. Bash
  commands in bubbles redact obvious secrets (`*_KEY=…`, `Bearer …`, `--password …`).
- Never approve permissions from the office. The ❗ only tells you where to look.
- The mod reads and writes only under `~/.claude/pixel-office/`, enforced with
  a `realPath` allow-list.

---

## 3. Customization
- **userConfig** (config menu): `displayName`, `character` (picker),
  `autoOpen`, `sounds`, `fps`, `smartBubbles` (Haiku one-line summaries, off
  by default because it costs tokens).
- **`~/.claude/pixel-office/theme.json`**: floor/wall colours, office layout
  preset (`open-plan`, `cafe`, `spaceship`, `garage`), desk count, day/night
  lighting by clock, custom names per project directory.
- **Sprite packs** `packs/<name>.json`: palette + string-art frames per state,
  validated, so people can share skins. A bad pack falls back to the built-in
  one and shows a toast naming the error.
- Per-project memory: the same repo always gets the same character and desk.

---

## 4. Build phases (each ends green before the next starts)

Every phase's **gate** is: `claude plugin validate` clean, `tsc` clean,
`claude plugin test` all passing, plus that phase's own live checks. The CLI
used is the bundled 2.1.287 one (the one on PATH is older, 2.1.251).

### Phase 0: Spikes (prove the risky parts, ~1 h)
| Spike | Question | Pass |
|---|---|---|
| S1 | Does a mod in the project folder hot-reload here (symlink into the dev-mods folder), or do we need a sync step? | edit → reload line seen |
| S2 | Does `Svg` render in the Cursor/VS Code pane, and how big can a pixel scene get under the 131 072-char limit? | 128×72 scene renders, size logged |
| S3 | Raster + blit at 8 fps on the terminal without flicker | visual check via `claude` in Ghostty/iTerm |
| S4 | `Client` pointer events over the scene region (terminal) | click logs x/y |
| S5 | `$.fs` read/write of `~/.claude/pixel-office`, `$.process.run(['rm'])` allowed | round-trip works |
| S6 | `classic.PermissionRequest` / `classic.Notification` fire in the extension | ❗ toast on a permission prompt |
| S7 | `$.prompt.submit` from a `$.clock.every` callback reaches an idle session | injected prompt runs |

Each spike that fails changes the plan before any feature code exists, using the
fallback named in §2.3.

### Phase 1: Core logic, test-first (no UI)
Build `agent.ts`, `signals.ts`, `roster.ts`, `inbox.ts`, `text.ts` and
`theme.ts` with tests written before each module.
Tests (`tests/core.*.test.ts`):
- state machine: every row in the §1 table; priority overlaps; timeouts
  (`done`→`idle` after 3 s, `idle` after 60 s, `away` after 20 s without a
  heartbeat, prune at 10 min) using the mocked clock
- signals: each tool name → state/bubble; unknown tool → `working`; MCP tool
  names; truncation at 60; ANSI/control stripping; secret redaction cases
- roster: merge, malformed JSON skipped, wrong `v` skipped, stable desk
  assignment (same id → same desk across reloads; collision resolution;
  more agents than desks → overflow row)
- inbox: encode/decode round-trip, reject oversize (>4 KB) / empty / non-string,
  ordering by ts, dedupe, cursor never re-delivers
- theme: defaults, partial merge, invalid values rejected with a reason

### Phase 2: Presence (sessions see each other, text UI)
`register.tsx`: `session.start` writes own record and starts the 2 s heartbeat
and 1 s roster poll; hooks update `me`; `session.end` writes `leaving`. A
`/office` command opens the Pane with a **text** roster (emoji + name + state
+ bubble), which stays as the permanent fallback renderer.
Tests: UI mount on `terminal`, `desktop`, `vscode` and `mobile`: chips render,
empty state, 12 agents, long names truncate to `bodyColumns`, needs-you sorts
first.
Live check: open 2–3 sessions (`claude` in terminals plus this one) and watch
all of them appear, change state and go away.

### Phase 3: Pixel renderer (pure) + sprites
`pixels.ts`, `sprites.ts`, `scene.ts`, `anim.ts`, `encode-raster.ts` and
`encode-svg.ts`. Built-in art: office tiles (floor, wall, window, desk,
monitor, chair, plant, coffee machine, bookshelf, door), 4 characters × states
(idle 2 f, typing 2 f, reading 2 f, writing 2 f, walk 4 f, hand-up 2 f,
stretch 2 f, sleep 2 f), intern, ❗, sweat drop and the bubble tail.
Tests:
- sprite sheets: every frame is the declared size and every char is in the
  palette (catches art typos)
- frame buffer: blit clipping at all 4 edges, transparency, compositing order
- raster encoder: known 2×4 frame → exact cell words; output length =
  cols×rows×12 bytes; only width-1 BMP glyphs
- svg encoder: deterministic output (golden string), stays under 131 072 chars
  for the largest layout with 9 agents, colours merged per path
- scene: layouts for widths 40/60/80/120 cols; desks never overlap; door
  reachable; walk path from door to every desk
- anim: same (state, t) → same frame; walking reaches the desk in N ticks

### Phase 4: Office view in the pane
Wire the renderer into the Pane per §2.3: Raster + blit loop on terminal, Svg
elsewhere, text fallback on refusal. Name chips with hotkeys under the scene.
Pause animation when the pane is hidden or unfocused for 30 s, to save CPU.
Tests: mount per surface → the expected element (`Raster` / `Svg` / text) is
present; the blit loop starts once and stops on `ui.close`; a resize re-lays
the scene.
Live check: watch the pane while this session works on real tasks.

### Phase 5: Talk to agents
Dialogue box (pane in focus/dialog mode): portrait, typewriter last lines,
`Input` to reply, `Send` / `Close`. Sending writes the inbox file. The target
session's mod polls, shows "📨 from you", then submits the prompt when idle.
The reply shows as that character's bubble and in the dialogue log. On the
terminal, clicking a character uses the Client hit test.
Tests: press chip → dialogue opens for that id; input + submit → exactly one
correctly shaped inbox write (fs mocked via an adapter); receiver: a new
message → one `prompt.submit`; the same message twice → still one; a malformed
message → ignored plus a log line; a message to self is delivered without
going through the inbox.
Live check: from this session, message a terminal session and watch it act.

### Phase 6: Polish and customization
Sounds (`$.audio.play`) for needs-you, done and message; AbovePrompt mini band
(small avatars + dots) for narrow terminals; theme.json; sprite packs; day/night
lighting; subagent interns (`agent.spawn` / Agent tool → intern count); meeting
room (when two agents message each other, both walk there); `smartBubbles`.
Tests: theme/pack validation fallbacks; band hides during a survey and
truncates to `bodyColumns`; intern count follows spawn/settle; sound respects
the `sounds` option.

### Phase 7: Hardening + packaging
- Soak: 9 sessions and 30 minutes, with no crash, no unbounded file growth
  (inbox GC) and CPU under ~3 % while animating
- Chaos: delete the office folder mid-run, corrupt a JSON file, kill a session
  with `kill -9`, clock jump, two sessions writing at the same instant
- README: install, screenshots, customization and pack format
- Package as a plugin with a marketplace entry, so installing is one
  `/plugin install` line; `--plugin-dir` instructions for local use

---

## 5. Test strategy summary
- **Unit (pure core):** the bulk of the tests, fast and deterministic, using
  the mocked clock.
- **UI mount tests:** every renderable site on every surface, looped over the
  surfaces so nothing depends on one.
- **Golden tests:** sprite and encoder output pinned, so art and encoder
  regressions show up as a diff.
- **Live checks:** a short checklist per phase, run in a real multi-session
  setup.
- **Gate script** `scripts/check.sh` runs validate, tsc and test in one
  command, before every phase is called done.

## 6. Risks and fallbacks
| Risk | Fallback |
|---|---|
| API is early access and changes between releases | keep `register.tsx` thin; the core has no engine imports; re-run validate after each update |
| Svg refused or too large in VS Code | lower the resolution, then fall back to the text roster |
| Raster flicker or too much CPU | fps option, pause when hidden, blit only on frame change |
| A hook throws | every hook wraps `next(e)` so the session itself is never blocked; failures go to `$.ui.log` |
| Stale files from crashed sessions | heartbeat timeout → `away`, prune after 10 min |
| File write races | one writer per file (own record, or a unique inbox file name); readers tolerate partial JSON |
