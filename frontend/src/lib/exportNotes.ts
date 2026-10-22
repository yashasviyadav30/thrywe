import { APP_URL } from '../config'
import type { AiNotesData, MapNode } from './aiNotes'
import { inlineParts, parseNotes } from './notesFormat'
import { clock } from './study'

// Export AI notes: a printable page (the phone's print dialog saves it as PDF) or a share to WhatsApp.
const at = (videoId: string, s: number) => `${APP_URL}/watch/${videoId}?t=${s}`

// short: the summary and each key point's line (as before). brief: the study notes, key terms and every point in full.
export type NotesLength = 'short' | 'brief'

// WhatsApp and Telegram read *bold*: the notes' ## headings and **bold** become that, their "- " bullets "•".
const starred = (t: string) => inlineParts(t).map((p) => (p.bold ? `*${p.text}*` : p.text)).join('')
function plainNotes(text: string): string {
  // a heading sits right above its own lines; other blocks get a blank line between them
  return parseNotes(text).reduce((out, b, i, all) => {
    const piece = b.kind === 'h' ? `*${b.text}*` : b.kind === 'ul' ? b.items.map((it) => `• ${starred(it)}`).join('\n') : starred(b.text)
    return out + (i === 0 ? '' : all[i - 1].kind === 'h' ? '\n' : '\n\n') + piece
  }, '')
}

export function notesText(title: string, videoId: string, notes: AiNotesData, length: NotesLength = 'short'): string {
  const time = (s: number | null) => (s !== null ? `${clock(s)} ` : '')
  const foot = ['', `Watch it on Thrywe: ${APP_URL}/watch/${videoId}`]
  if (length === 'short') {
    const points = notes.points.map((p) => `• ${time(p.seconds)}${p.title}: ${p.short}`)
    return [title, '', notes.summary, '', ...points, ...foot].join('\n')
  }
  const parts = [title, '', '*Brief summary*', notes.summary]
  if (notes.brief) parts.push('', '*Summary*', plainNotes(notes.brief))
  if (notes.terms?.length) parts.push('', '*Key terms*', ...notes.terms.map((t) => `• ${t.term}: ${t.meaning}`))
  parts.push('', '*Key points*', ...notes.points.map((p) => `• ${time(p.seconds)}*${p.title}*: ${p.short}\n${p.detail}\n`))
  return [...parts, ...foot].join('\n')
}

// The mind map as an indented outline, the main idea first.
export function mapText(title: string, videoId: string, nodes: MapNode[]): string {
  const lines: string[] = []
  const walk = (parent: string | null, depth: number, seen: Set<string>) => {
    for (const n of nodes.filter((x) => x.parent === parent && !seen.has(x.id))) {
      seen.add(n.id)
      const label = depth === 0 ? `*${n.label}*` : `${'   '.repeat(depth - 1)}• ${n.label}`
      lines.push(n.detail && depth > 0 ? `${label}: ${n.detail}` : label)
      walk(n.id, depth + 1, seen)
    }
  }
  walk(null, 0, new Set())
  return [`${title}: mind map`, '', ...lines, '', `Watch it on Thrywe: ${APP_URL}/watch/${videoId}`].join('\n')
}

export function shareNotes(title: string, videoId: string, notes: AiNotesData, length: NotesLength = 'short') {
  return shareText(title, notesText(title, videoId, notes, length))
}

// The phone's share sheet; without one (most laptops), WhatsApp in a new tab.
export async function shareText(title: string, text: string): Promise<'shared' | 'whatsapp'> {
  if (navigator.share) {
    try {
      await navigator.share({ title, text })
      return 'shared'
    } catch (e) {
      if ((e as Error).name === 'AbortError') return 'shared' // the user closed the share sheet
    }
  }
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener')
  return 'whatsapp'
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

// The sectioned notes as escaped HTML for the printable page (same reading as the app's NotesText).
function notesHtml(text: string): string {
  const inline = (t: string) => inlineParts(t).map((p) => (p.bold ? `<b>${esc(p.text)}</b>` : esc(p.text))).join('')
  return parseNotes(text)
    .map((b) =>
      b.kind === 'h' ? `<h3>${esc(b.text)}</h3>` : b.kind === 'ul' ? `<ul>${b.items.map((i) => `<li>${inline(i)}</li>`).join('')}</ul>` : `<p>${inline(b.text)}</p>`,
    )
    .join('')
}

function outline(nodes: MapNode[], parent: string | null, seen = new Set<string>()): string {
  const kids = nodes.filter((n) => n.parent === parent && !seen.has(n.id))
  if (!kids.length) return ''
  kids.forEach((n) => seen.add(n.id))
  return `<ul>${kids
    .map((n) => `<li><b>${esc(n.label)}</b>${n.detail ? `: ${esc(n.detail)}` : ''}${outline(nodes, n.id, seen)}</li>`)
    .join('')}</ul>`
}

export function printableHtml(title: string, videoId: string, notes: AiNotesData): string {
  const time = (s: number | null) => (s === null ? '' : `<a href="${at(videoId, s)}">${clock(s)}</a> `)
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} - summary</title>
<style>
body{font:15px/1.6 system-ui,'Segoe UI',Roboto,'Noto Sans Devanagari',sans-serif;color:#1b2130;background:#fff;max-width:720px;margin:32px auto;padding:0 20px}
h1{font-size:22px;line-height:1.3;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px}
.sum{background:#eef1fb;border-radius:12px;padding:12px 16px;white-space:pre-line}
ol{padding-left:20px}li{margin:0 0 10px}a{color:#3550d8;text-decoration:none;font-variant-numeric:tabular-nums}
.short{color:#586174}.note{font-size:12px;color:#586174;margin-top:32px}
ul{padding-left:18px}ul ul{border-left:1px solid #e2e5ec;margin:4px 0}
@media print{body{margin:0}}
</style></head><body>
<h1>${esc(title)}</h1><p class="short">Watch it on Thrywe: <a href="${APP_URL}/watch/${videoId}">${APP_URL}/watch/${videoId}</a></p>
<h2>Brief summary</h2><p class="sum">${esc(notes.summary)}</p>${notes.brief ? `<h2>Summary</h2>${notesHtml(notes.brief)}` : ''}${
    notes.terms?.length
      ? `<h2>Key terms</h2><dl>${notes.terms.map((t) => `<dt><b>${esc(t.term)}</b></dt><dd>${esc(t.meaning)}</dd>`).join('')}</dl>`
      : ''
  }
<h2>Key points</h2><ol>${notes.points
    .map((p) => `<li>${time(p.seconds)}<b>${esc(p.title)}</b><br><span class="short">${esc(p.short)}</span><br>${esc(p.detail)}</li>`)
    .join('')}</ol>
<h2>Mind map</h2>${outline(notes.mindmap, null)}
<p class="note">Made by AI from the video, not by YouTube or the teacher. Check with the video. Thrywe: ${APP_URL}</p>
<script>window.onload=()=>setTimeout(()=>print(),300)</script>
</body></html>`
}

export function printNotes(title: string, videoId: string, notes: AiNotesData): boolean {
  const w = window.open('', '_blank')
  if (!w) return false // pop-up blocked
  w.document.write(printableHtml(title, videoId, notes))
  w.document.close()
  return true
}

// The user's own notepad (TipTap JSON) as a message: headings and bold in WhatsApp's *bold*, lists as bullets,
// ticks for checklists. Screenshots stay out (they're private to the account); time stamps keep their "[12:40]".
type DocNode = { type?: string; text?: string; attrs?: Record<string, unknown>; marks?: { type: string }[]; content?: DocNode[] }
function inlineText(n: DocNode): string {
  if (n.type === 'hardBreak') return '\n'
  if (n.type !== 'text') return (n.content ?? []).map(inlineText).join('')
  const types = new Set((n.marks ?? []).map((m) => m.type))
  const t = n.text ?? ''
  if (!t.trim() || types.has('link')) return t
  return types.has('bold') ? `*${t}*` : types.has('italic') ? `_${t}_` : types.has('strike') ? `~${t}~` : t
}
function blockText(n: DocNode, depth = 0): string[] {
  const pad = '   '.repeat(depth)
  const kids = n.content ?? []
  switch (n.type) {
    case 'heading':
      return [`*${kids.map(inlineText).join('').replace(/\*/g, '')}*`]
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return kids.flatMap((item, i) => {
        const mark = n.type === 'orderedList' ? `${i + 1}.` : n.type === 'taskList' ? (item.attrs?.checked ? '☑' : '☐') : '•'
        const [first = '', ...rest] = (item.content ?? []).flatMap((c) => blockText(c, depth + 1))
        return [`${pad}${mark} ${first.trimStart()}`, ...rest]
      })
    case 'blockquote':
      return kids.flatMap((c) => blockText(c, depth)).map((l) => `> ${l}`)
    case 'image':
    case 'horizontalRule':
      return []
    default: {
      const line = kids.map(inlineText).join('')
      return line.trim() ? [pad + line] : []
    }
  }
}
export function notepadText(title: string, videoId: string, content: string): string {
  let doc: DocNode = {}
  try {
    doc = JSON.parse(content)
  } catch {
    // an empty or broken note shares just the title and link
  }
  const body = (doc.content ?? []).map((b) => blockText(b).join('\n')).filter(Boolean).join('\n\n')
  return [`My notes: ${title}`, '', body, '', `Watch it on Thrywe: ${APP_URL}/watch/${videoId}`].join('\n').replace(/\n{3,}/g, '\n\n')
}

// The message a shared video carries: only the Thrywe link, so it opens in Thrywe with its summary and mind map
// (a YouTube link here would open the YouTube app instead).
export function videoShareText(title: string, videoId: string): string {
  return `${title}

Watch it on Thrywe, with its AI summary and mind map: ${APP_URL}/watch/${videoId}`
}
