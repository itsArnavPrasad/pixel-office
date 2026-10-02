# Pixel Office for Claude Code

Every Claude Code session you run shows up as a pixel-art character in a shared office:
who is working on what, who is waiting for you, and one click to talk to any of them.

## What you get
- **The office**: a live 2D office in a panel and a mini view in the activity bar. Characters act out
  what their session is doing: typing, reading, writing, browsing, delegating to interns, stretching when done.
- **Click a character** to see its recent conversation and send it a message. The message becomes that
  session's next prompt.
- **Needs you**: when a session waits for a permission or an answer, its character raises a hand. You get a
  notification with **Jump**, a chime, and a badge in the status bar. `Ctrl+Cmd+N` (macOS) / `Ctrl+Alt+N` goes to the next one.
- **Jump to session**: sessions running in an integrated terminal are focused directly.
- **Standup**: one button, and every session reports Done / Next / Blocked from its own conversation.
- **Collision radar**: warns when two live agents edited the same file.
- **Insights**: per-agent git changes and token use.

## Setup
Run **Pixel Office: Enable in All Claude Code Sessions** from the Command Palette (or click **Enable** in the
office). It copies the bundled Pixel Office mod to `~/.claude/pixel-office/mod` and adds that folder to
`CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`, keeping a backup at `settings.json.pixel-office.bak`.
New Claude Code sessions then join the office. **Pixel Office: Disable…** undoes it.

## Privacy
Everything stays on your machine, in `~/.claude/pixel-office/`. Nothing is sent anywhere.
