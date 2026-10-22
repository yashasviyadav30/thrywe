import { Brain, ChevronDown, Clock3, CopyPlus, FileDown, Hourglass, Share2, Sparkles, TriangleAlert } from './icons'
import { useState } from 'react'
import { LANGS, briefDoc, copyLine, startsAt, type AiNotesData, type AiPoint, type AiTerm, type NotesLang } from '../lib/aiNotes'
import { inlineParts, parseNotes } from '../lib/notesFormat'
import { printNotes, shareNotes, type NotesLength } from '../lib/exportNotes'
import PopMenu from './PopMenu'
import { clock } from '../lib/study'
import { notesOf, type AiNotesView, type useAiNotes } from '../lib/useAiNotes'

export function LangPicker({ lang, onPick }: { lang: NotesLang; onPick: (l: NotesLang) => void }) {
  return (
    <select className="ai-lang" aria-label="Notes language" value={lang} onChange={(e) => onPick(e.target.value as NotesLang)}>
      {LANGS.map((l) => (
        <option key={l.id} value={l.id}>
          {l.label}
        </option>
      ))}
    </select>
  )
}

// Everything that isn't "ready": the same messages serve the Notes and Mind map tabs.
export function AiNotesStatus({ view, onGenerate, what }: { view: AiNotesView; onGenerate: () => void; what: string }) {
  if ('kind' in view) {
    if (view.kind === 'loading')
      return (
        <div className="ai-skeleton" aria-busy="true" aria-label="Loading">
          <div className="skeleton" style={{ height: 56 }} />
          <div className="skeleton" style={{ height: 88 }} />
          <div className="skeleton" style={{ height: 88 }} />
        </div>
      )
    if (view.kind === 'error')
      return (
        <div className="ai-state" role="alert">
          <TriangleAlert size={22} aria-hidden="true" />
          <p>{view.message}</p>
        </div>
      )
    return null
  }
  switch (view.status) {
    case 'none':
      return (
        <div className="ai-state ai-start">
          <Sparkles size={24} aria-hidden="true" />
          <h3>A summary and a mind map of this video</h3>
          <p>Made by AI from the video in about a minute. Everyone who opens this video gets it too.</p>
          <button onClick={onGenerate}>
            <Sparkles size={17} aria-hidden="true" /> Generate {what}
          </button>
        </div>
      )
    case 'queued':
      return view.reason === 'daily_limit' ? (
        <div className="ai-state">
          <Clock3 size={22} aria-hidden="true" />
          <h3>Queued: starts {startsAt(view.starts_at)}</h3>
          <p>Everyone on Thrywe shares one free AI allowance a day, and today’s is used up. Nothing for you to do: this summary starts by itself then, and opens for everyone. Meanwhile, take your own notes in My notes.</p>
        </div>
      ) : (
        <div className="ai-state" role="status">
          <Hourglass size={22} aria-hidden="true" className="ai-spin" />
          <h3>Making your summary…</h3>
          {view.progress && (
            <div className="ai-progress" aria-label={`${view.progress.done} of ${view.progress.total} parts read`}>
              <span style={{ width: `${Math.max(6, (100 * view.progress.done) / view.progress.total)}%` }} />
            </div>
          )}
          <p>
            {view.progress
              ? `A long video: ${view.progress.done} of ${view.progress.total} parts read. `
              : ''}
            {view.reason === 'busy'
              ? 'The AI is busy right now and keeps trying by itself. Keep watching; this page updates on its own.'
              : 'Usually under a minute, a little longer for long videos. Keep watching; this page updates on its own.'}
          </p>
        </div>
      )
    case 'too_long':
      return (
        <div className="ai-state">
          <Clock3 size={22} aria-hidden="true" />
          <h3>This video is too long for an AI summary</h3>
          <p>AI summaries work on videos up to 6 hours. Use My notes for this one.</p>
        </div>
      )
    case 'unavailable':
      return (
        <div className="ai-state">
          <TriangleAlert size={22} aria-hidden="true" />
          <h3>AI summaries aren’t switched on yet</h3>
          <p>The server isn’t set up for AI summaries right now. Use My notes for this video; the summary will appear here once it’s on.</p>
        </div>
      )
    case 'failed':
      return (
        <div className="ai-state">
          <TriangleAlert size={22} aria-hidden="true" />
          <h3>Couldn’t make a summary of this video</h3>
          <p>The AI couldn’t read it after several tries. It is often busy for a while; try again in a few minutes.</p>
          <button onClick={onGenerate}>
            <Sparkles size={17} aria-hidden="true" /> Try again
          </button>
        </div>
      )
    default:
      return null
  }
}

// Gemini doesn't always list points in teaching order; points without a time keep their place at the end.
const byTime = (points: AiPoint[]) =>
  [...points].sort((a, b) => (a.seconds ?? Infinity) - (b.seconds ?? Infinity))

// The AI's detailed notes, drawn as sections, paragraphs and bullet lists (see lib/notesFormat).
function Inline({ text }: { text: string }) {
  return (
    <>
      {inlineParts(text).map((part, i) => (part.bold ? <strong key={i}>{part.text}</strong> : <span key={i}>{part.text}</span>))}
    </>
  )
}
function NotesText({ text }: { text: string }) {
  return (
    <>
      {parseNotes(text).map((b, i) =>
        b.kind === 'h' ? (
          <h4 key={i}>{b.text}</h4>
        ) : b.kind === 'ul' ? (
          <ul key={i}>
            {b.items.map((item, j) => (
              <li key={j}>
                <Inline text={item} />
              </li>
            ))}
          </ul>
        ) : (
          <p key={i}>
            <Inline text={b.text} />
          </p>
        ),
      )}
    </>
  )
}

function KeyTerms({ terms }: { terms: AiTerm[] }) {
  return (
    <section className="key-terms" aria-labelledby="terms-title">
      <h3 className="ai-sub" id="terms-title">
        Key terms
      </h3>
      <dl>
        {terms.map((t) => (
          <div key={t.term}>
            <dt>{t.term}</dt>
            <dd>{t.meaning}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

// The summary covers the whole video; "Detailed summary" opens the long, sectioned one below it.
// In the data `summary` is the paragraph and `brief` the detailed one (field names kept from before).
function SummaryCard({ notes, offline }: { notes: AiNotesData; offline: boolean }) {
  const [open, setOpen] = useState(false)
  // Notes made before the sectioned format have no sections: their key points stand in for them.
  const detailed = notes.brief || notes.points.map((p) => `${p.title}. ${p.detail}`).join('\n\n')
  return (
    <section className="sum-card" aria-labelledby="sum-title">
      <p className="sum-k" id="sum-title">
        <Sparkles size={16} weight="fill" aria-hidden="true" /> Summary
      </p>
      <p className="sum-short">{notes.summary}</p>
      <button className="sum-toggle" aria-expanded={open} aria-controls="sum-detailed" onClick={() => setOpen(!open)}>
        {open ? 'Hide detailed summary' : 'Detailed summary'}
        <ChevronDown size={16} weight="bold" aria-hidden="true" className={open ? 'flip' : ''} />
      </button>
      <div id="sum-detailed" className={`sum-brief${open ? ' open' : ''}`} hidden={!open}>
        <NotesText text={detailed} />
      </div>
      <AiLabel offline={offline} />
    </section>
  )
}

// Over the early notes of a long video: how much is ready, and that the rest is on its way.
export function PartialBanner({ view }: { view: AiNotesView }) {
  if (!('status' in view) || view.status !== 'queued' || !view.partial) return null
  const minutes = Math.round((view.covered_s ?? 0) / 60)
  return (
    <p className="partial-banner" role="status">
      <Hourglass size={16} aria-hidden="true" className="ai-spin" /> First {minutes} minutes ready. Reading the rest
      {view.progress ? `: ${view.progress.done} of ${view.progress.total} parts` : ''}. This page fills in by itself.
    </p>
  )
}

// One small line where the AI's work ends, like ChatGPT's "can make mistakes".
export function AiLabel({ offline }: { offline?: boolean }) {
  return (
    <p className="ai-label">
      Made by AI from the video, not by the teacher. AI can make mistakes, so check important points with the video.
      {offline && ' Showing your saved copy (offline).'}
    </p>
  )
}

export default function AiNotesPanel({
  ai,
  title,
  videoId,
  onSeek,
  onCopy,
  onToast,
}: {
  ai: ReturnType<typeof useAiNotes>
  title: string
  videoId: string
  onSeek: (t: number) => void
  onCopy: (lines: ReturnType<typeof copyLine>[], done: string) => void
  onToast: (msg: string) => void
}) {
  const notes = notesOf(ai.view)
  const [testing, setTesting] = useState(false)
  // Short or in full is the reader's choice, for sharing and for copying to My notes alike.
  const pointLine = (p: AiPoint, full: boolean) => copyLine(p.title, full ? `${p.short} ${p.detail}` : p.short, p.seconds)
  const copyPoints = (points: AiPoint[], full: boolean) =>
    onCopy(points.map((p) => pointLine(p, full)), `Copied ${points.length} key point${points.length === 1 ? '' : 's'} to My notes.`)
  const share = async (length: NotesLength) =>
    notes && (await shareNotes(title, videoId, notes, length)) === 'whatsapp' && onToast('Opening WhatsApp…')
  return (
    <div className="ai-notes">
      <div className="ai-head">
        <LangPicker lang={ai.lang} onPick={ai.chooseLang} />
      </div>
      {!notes ? (
        <AiNotesStatus view={ai.view} onGenerate={ai.generate} what="summary" />
      ) : (
        <>
          <PartialBanner view={ai.view} />
          <SummaryCard notes={notes} offline={'kind' in ai.view && ai.view.kind === 'offline'} />
          {notes.terms && notes.terms.length > 0 && <KeyTerms terms={notes.terms} />}
          <div className="ai-sub-row">
            <h3 className="ai-sub">Key points</h3>
            <div className="ai-sub-actions">
              <button className="small secondary" aria-pressed={testing} onClick={() => setTesting(!testing)}>
                <Brain size={16} aria-hidden="true" /> {testing ? 'Back to reading' : 'Test yourself'}
              </button>
              <PopMenu
                items={[
                  { label: 'Key points, short', onPick: () => copyPoints(byTime(notes.points), false) },
                  { label: 'Key points in full', hint: 'With each point’s details', onPick: () => copyPoints(byTime(notes.points), true) },
                  ...(notes.brief
                    ? [{ label: 'Detailed summary', hint: 'In sections', onPick: () => onCopy(briefDoc(notes.brief!), 'Copied the detailed summary to My notes.') }]
                    : []),
                ]}
              >
                <CopyPlus size={16} aria-hidden="true" /> Copy all
              </PopMenu>
            </div>
          </div>
          {testing ? (
            <RecallDeck points={byTime(notes.points)} onSeek={onSeek} />
          ) : (
          <ol className="ai-points">
            {byTime(notes.points).map((p, i) => (
              <li key={i}>
                <details>
                  <summary>
                    <span className="ai-point-head">
                      {p.seconds !== null && (
                        <button
                          className="ts-chip"
                          onClick={(e) => {
                            e.preventDefault()
                            onSeek(p.seconds!)
                          }}
                          aria-label={`Play from ${clock(p.seconds)}`}
                        >
                          {clock(p.seconds)}
                        </button>
                      )}
                      <b>{p.title}</b>
                      <ChevronDown size={16} className="ai-chev" aria-hidden="true" />
                    </span>
                    <span className="ai-short">{p.short}</span>
                  </summary>
                  <p className="ai-detail">{p.detail}</p>
                  <PopMenu
                    className="link ai-copy"
                    items={[
                      { label: 'Short', onPick: () => onCopy([pointLine(p, false)], 'Copied to My notes.') },
                      { label: 'In full', hint: 'With the details above', onPick: () => onCopy([pointLine(p, true)], 'Copied to My notes.') },
                    ]}
                  >
                    <CopyPlus size={15} aria-hidden="true" /> Copy to my notes
                  </PopMenu>
                </details>
              </li>
            ))}
          </ol>
          )}
          <div className="ai-export">
            <button
              className="small secondary"
              onClick={() => printNotes(title, videoId, notes) || onToast('Allow pop-ups for this site to save the PDF.')}
            >
              <FileDown size={16} aria-hidden="true" /> Download PDF
            </button>
            <PopMenu
              items={[
                { label: 'Summary', hint: 'The summary and key points', onPick: () => share('short') },
                { label: 'Detailed summary', hint: 'Detailed summary, key terms and every point in full', onPick: () => share('brief') },
              ]}
            >
              <Share2 size={16} aria-hidden="true" /> Share summary
            </PopMenu>
          </div>
        </>
      )}
    </div>
  )
}

// "Test yourself": each key point's title is the question; try to recall it, then reveal. Active recall from the
// summary's own words, no score and nothing kept (R8: no points or streaks).
function RecallDeck({ points, onSeek }: { points: AiPoint[]; onSeek: (t: number) => void }) {
  const [shown, setShown] = useState<Set<number>>(new Set())
  const reveal = (i: number) => setShown((s) => new Set(s).add(i))
  return (
    <>
      <p className="help recall-help">Read each title, say the idea in your own words, then check.</p>
      <ol className="recall">
        {points.map((p, i) => (
          <li key={i} className={shown.has(i) ? 'open' : ''}>
            <b>{p.title}</b>
            {shown.has(i) ? (
              <div className="recall-answer">
                <p>{p.short}</p>
                {p.seconds !== null && (
                  <button className="ts-chip" onClick={() => onSeek(p.seconds!)} aria-label={`Play from ${clock(p.seconds)}`}>
                    {clock(p.seconds)}
                  </button>
                )}
              </div>
            ) : (
              <button className="small" onClick={() => reveal(i)}>
                Show answer
              </button>
            )}
          </li>
        ))}
      </ol>
      {shown.size > 0 && (
        <button className="link" onClick={() => setShown(new Set())}>
          Hide the answers and go again
        </button>
      )}
    </>
  )
}
