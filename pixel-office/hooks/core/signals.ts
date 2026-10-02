// What a tool call looks like in the office: an activity, a bubble a person can read at a
// glance ("Running tests", "Editing auth.ts"), and the raw detail for whoever wants it.
import type { AgentState } from '../../types'
import { basename, bubble } from './text'

export type Activity = { state: AgentState; bubble: string; detail: string }

type Input = Record<string, unknown>
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** The step of a shell line that says what it is for: past `cd x &&`, env assignments and `sudo`. */
function mainStep(command: string): string {
  const steps = command.split(/&&|\|\||;|\n/).map(s => s.trim()).filter(Boolean)
  const step = steps.find(s => !/^(cd|export|set|source|\.)\s/.test(s) && !/^[A-Z_][A-Z0-9_]*=\S*$/.test(s)) ?? steps[0] ?? ''
  return step.replace(/^(\s*[A-Z_][A-Z0-9_]*=\S*\s+)+/, '').replace(/^(sudo|time|npx|bunx|exec)\s+/, '')
}

// order matters: installing a test or build tool is still installing
const RULES: [RegExp, string][] = [
  [/\b(npm|pnpm|yarn|bun)\s+(i|install|add|ci)\b|pip3? install|brew install|cargo add|go get|poetry add|uv (add|pip)/, 'Installing packages'],
  [/\b(test|jest|vitest|pytest|mocha|rspec|phpunit|ava|tap)\b|go test|cargo test|plugin test|--test\b/, 'Running tests'],
  [/\b(tsc|eslint|ruff|mypy|pyright|lint|prettier|biome|typecheck|clippy|check\.sh|validate)\b/, 'Checking types and lint'],
  [/\b(build|esbuild|webpack|rollup|vite build|tsup|make|gradle|mvn|xcodebuild)\b|cargo build|go build|vsce package/, 'Building'],
  [/^git (commit|cherry-pick|rebase|merge)/, 'Committing'],
  [/^git push/, 'Pushing'],
  [/^git (pull|fetch|clone)/, 'Pulling code'],
  [/^git (diff|status|log|show|blame)/, 'Reviewing changes'],
  [/^git /, 'Using git'],
  [/^gh pr\b/, 'Working on a pull request'],
  [/^gh /, 'Using GitHub'],
  [/\b(dev|start|serve)\b|runserver|flask run|uvicorn|rails s/, 'Starting the app'],
  [/^(curl|wget|http|xh)\b/, 'Calling a URL'],
  [/^(docker|docker-compose|kubectl|helm|terraform)\b/, 'Working on infrastructure'],
  [/^(ls|cat|head|tail|find|grep|rg|ag|sed -n|wc|tree|pwd|stat|file|du|less|awk)\b/, 'Looking through the code'],
  [/^(mkdir|rm|mv|cp|touch|chmod|ln|tar|unzip|zip)\b/, 'Moving files around'],
  [/^(node|python3?|ruby|deno|bun|go run|cargo run|java|php|sh|bash|zsh)\b/, 'Running a script'],
  [/^(ps|kill|pkill|lsof|top)\b/, 'Checking processes'],
]

/** "npm test -- login.spec.ts" → "Running tests"; anything unknown is "Running a command". */
export function describeCommand(command: string): string {
  const step = mainStep(command)
  return RULES.find(([re]) => re.test(step))?.[1] ?? 'Running a command'
}

export function activityFor(tool: string, input: Input = {}): Activity {
  const file = basename(str(input.file_path) || str(input.notebook_path) || str(input.path))
  const act = (state: AgentState, text: string, detail = ''): Activity => ({ state, bubble: bubble(text), detail: bubble(detail, 160) })
  switch (tool) {
    case 'Bash':
      return act('typing', describeCommand(str(input.command)), `$ ${str(input.command)}`)
    case 'Read':
      return act('reading', file ? `Reading ${file}` : 'Reading', str(input.file_path))
    case 'Grep':
      return act('reading', str(input.pattern) ? `Searching for ${str(input.pattern)}` : 'Searching the code', str(input.path))
    case 'Glob':
    case 'LS':
      return act('reading', 'Finding files', str(input.pattern) || str(input.path))
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return act('writing', file ? `Editing ${file}` : 'Editing', str(input.file_path) || str(input.notebook_path))
    case 'Write':
      return act('writing', file ? `Writing ${file}` : 'Writing a file', str(input.file_path))
    case 'TodoWrite':
      return act('writing', 'Updating the plan')
    case 'WebSearch':
      return act('browsing', `Searching the web: ${str(input.query)}`, str(input.query))
    case 'WebFetch':
      return act('browsing', `Reading ${hostOf(str(input.url))}`, str(input.url))
    case 'Agent':
    case 'Task':
      return act('delegating', `Delegating: ${str(input.description) || 'a subtask'}`, str(input.prompt))
    case 'AskUserQuestion':
      return act('needs-you', firstQuestion(input) || 'I have a question')
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
  if (mcp) return act('working', `Using ${mcp[1]}: ${mcp[2]!.replace(/_/g, ' ')}`)
  return act('working', `Using ${tool}`)
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function firstQuestion(input: Input): string {
  const qs = input.questions
  if (Array.isArray(qs) && qs[0] && typeof qs[0] === 'object') return str((qs[0] as Input).question)
  return ''
}
