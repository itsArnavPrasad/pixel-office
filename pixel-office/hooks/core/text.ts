// Text shown in bubbles and dialogue: never trusted, always cleaned.

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)/g
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g

export function clean(text: string): string {
  return text.replace(ANSI, '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
}

export function truncate(text: string, max: number): string {
  const chars = [...text]
  return chars.length <= max ? text : chars.slice(0, Math.max(0, max - 1)).join('') + '…'
}

const SECRETS: [RegExp, string][] = [
  [/\b([A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD|PASS)[A-Z0-9_]*)=\S+/gi, '$1=***'],
  [/\b(Bearer|Basic)\s+\S+/gi, '$1 ***'],
  [/(--?(password|token|secret|api-key)[= ])\S+/gi, '$1***'],
  [/\b(sk|pk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{8,}/g, '***'],
]

export function redact(text: string): string {
  return SECRETS.reduce((s, [re, to]) => s.replace(re, to), text)
}

/** The first sentence of a model reply, markdown stripped, for a bubble. */
export function firstSentence(text: string): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*_`>|]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  const line = plain.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? ''
  const match = /^(.+?[.!?])(\s|$)/.exec(line)
  return clean(match?.[1] ?? line)
}

/** A bubble: cleaned, redacted, cut to fit. */
export function bubble(text: string, max = 60): string {
  return truncate(redact(clean(text)), max)
}

export function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

/** Wrap to lines of at most `width` chars, breaking long words. */
export function wrap(text: string, width: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(' ').filter(Boolean)) {
    let w = word
    while ([...w].length > width) {
      if (line) lines.push(line), (line = '')
      lines.push([...w].slice(0, width).join(''))
      w = [...w].slice(width).join('')
    }
    if (!line) line = w
    else if ([...line].length + 1 + [...w].length <= width) line += ' ' + w
    else lines.push(line), (line = w)
  }
  if (line) lines.push(line)
  return lines
}
