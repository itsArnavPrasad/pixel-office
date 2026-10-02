// Turning untrusted text into safe HTML for the console.

export const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)

export const short = (s: string, n: number) => ([...s].length > n ? [...s].slice(0, n - 1).join('') + '…' : s)

/**
 * A small, safe subset of markdown: fenced code, inline code, bold, links shown as text.
 * Everything is escaped first, so no tag in the input survives.
 */
export function markdown(src: string): string {
  const parts = src.split(/```/)
  return parts
    .map((part, i) => {
      if (i % 2 === 1) {
        const nl = part.indexOf('\n')
        const lang = nl > 0 && /^[\w+-]{1,20}$/.test(part.slice(0, nl).trim()) ? part.slice(0, nl).trim() : ''
        const code = lang ? part.slice(nl + 1) : part.replace(/^\n/, '')
        return `<pre class="code"${lang ? ` data-lang="${esc(lang)}"` : ''}><code>${esc(code.replace(/\n$/, ''))}</code></pre>`
      }
      return esc(part)
        .replace(/`([^`\n]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
        .replace(/\[([^\]\n]+)\]\((?:[^()\s]|\([^()\s]*\))+\)/g, '$1') // a link shows its text; one level of parens in the URL
        .replace(/^#{1,6} (.+)$/gm, '<b>$1</b>')
        .replace(/\n/g, '<br>')
    })
    .join('')
}

/** 14:03:41 for today, "Oct 2 14:03" otherwise; '' for an unknown time. */
export function clock(at: number, now = Date.now()): string {
  if (!at) return ''
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  const hms = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  return new Date(now).toDateString() === d.toDateString()
    ? hms
    : `${d.toLocaleString('en', { month: 'short' })} ${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** ~/code/web instead of /Users/me/code/web. */
export function tildify(path: string, home: string): string {
  return home && (path === home || path.startsWith(home + '/')) ? `~${path.slice(home.length)}` : path
}
