#!/bin/sh
# The gate: validate, type-check, test. Run before calling any phase done.
set -e
cd "$(dirname "$0")/.."
CLAUDE="${CLAUDE:-$(ls -d ~/.cursor/extensions/anthropic.claude-code-*/resources/native-binary/claude ~/.vscode/extensions/anthropic.claude-code-*/resources/native-binary/claude 2>/dev/null | tail -1)}"
CLAUDE="${CLAUDE:-claude}"
mkdir -p typecheck && cp "$(ls -t /private/tmp/claude-*/bundled-skills/*/*/plugin-authoring/types/claude-code.d.ts 2>/dev/null | head -1 || echo typecheck/claude-code.d.ts)" typecheck/claude-code.d.ts 2>/dev/null || true
"$CLAUDE" plugin validate pixel-office | grep -E "✘|✔"
npx tsc -p .
echo "✔ types"
"$CLAUDE" plugin test pixel-office 2>&1 | tail -3
