# Pixel Office for Claude Code

Every Claude Code session you run shows up as a pixel-art character in a shared office:
who is working on what, who is waiting for you, and one click to talk to any of them.

## What you get
- **Rooms per repository**: sessions in the same repo (worktrees included) share an office room named after
  the repo, with its branch, its own pixel scene and a roster. Rooms that need you sort first.
- **Plain-words activity**: bubbles say *Running tests*, *Editing auth.ts*, *Committing*. The exact command is in
  the hover card and the console.
- **Needs you**: when a session waits for a permission or an answer, its character raises a hand. You get a
  notification with **Jump**, a chime and a status-bar badge. `Ctrl+Cmd+N` (macOS) / `Ctrl+Alt+N` goes to the next one.
- **Agent console**: click an agent to see what it's doing now, your task, its plan with progress, the files it
  changed and recent failures, then the conversation. Tool calls are folded into "N actions" strips with failures
  flagged in red; open one for input and output, or switch to *Everything*. **Transcript** opens the raw `.jsonl`.
- **Talk to it**: what you type becomes that session's next prompt.
- **New agents**: **＋** in a room (or **Pixel Office: New Agent…**) asks for a name and a task, then opens a Claude
  Code tab or a terminal in that repo. The new session takes the name and starts on the task.
- **Standup**: per room or for everyone. Each agent reports Done / Next / Blocked from its own conversation.
- **Collision radar**: warns when two live agents edited the same file.
- **Insights**: per-agent git changes and token use (new vs. cached).
- **Jump to session**: sessions in an integrated terminal are focused directly; for others it tells you where they are.

## Setup
Run **Pixel Office: Enable in All Claude Code Sessions** from the Command Palette (or click **Enable** in the
office). It copies the bundled Pixel Office mod to `~/.claude/pixel-office/mod` and adds that folder to
`CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`, keeping a backup at `settings.json.pixel-office.bak`.
New Claude Code sessions then join the office. **Pixel Office: Disable…** undoes it. When the extension updates,
the installed mod is refreshed automatically.

## Privacy
Everything stays on your machine, in `~/.claude/pixel-office/`. Nothing is sent anywhere.
