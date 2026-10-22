import {
  AlignLeft,
  Check,
  CircleHelp,
  Info,
  MapPin,
  MessageSquare,
  Network,
  NotebookPen,
  Pencil,
  RotateCcw,
  Sparkles,
  Star,
  Trash2,
} from '../components/icons'
import { useConfirmTap } from '../lib/useConfirmTap'
import { useBackToClose } from '../lib/useBackToClose'
import { Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { lazyWithReload } from '../lib/lazy'
import { Link, useLocation, useParams } from 'react-router'
import AiNotesPanel from '../components/AiNotesPanel'
import ShareToGroup from '../components/ShareToGroup'
import Comments from '../components/Comments'
import Description from '../components/Description'
import Player from '../components/Player'
import { appendToDoc, copyLine } from '../lib/aiNotes'
import { useAiNotes, notesOf } from '../lib/useAiNotes'
import { ago } from '../lib/search'
import { VIDEO_ID, type YTPlayer } from '../lib/youtube'
import {
  TAGS,
  tagLabel,
  addNote,
  clock,
  deleteNote,
  lectureTitle,
  openLecture,
  saveNotepad,
  saveProgress,
  starVideo,
  updateNote,
  type Note,
  type StudyData,
  type Tag,
} from '../lib/study'

// The rich-text editor and the map library are big, so each loads only when its tab first opens.
const Notepad = lazyWithReload(() => import('../components/Notepad'))
const MindMap = lazyWithReload(() => import('../components/MindMap'))

const PROGRESS_EVERY_MS = 15000

export default function Watch() {
  const { videoId = '' } = useParams()
  if (!VIDEO_ID.test(videoId)) {
    return (
      <section>
        <h1>Video not found</h1>
        <p>That link doesn’t point to a YouTube video.</p>
        <Link to="/search">Search instead</Link>
      </section>
    )
  }
  return <StudyPage key={videoId} videoId={videoId} />
}

function StudyPage({ videoId }: { videoId: string }) {
  const player = useRef<YTPlayer | null>(null)
  const [data, setData] = useState<StudyData | null>(null)
  const [missing, setMissing] = useState(false) // YouTube doesn't know this video (a wrong or deleted link)
  const [notes, setNotes] = useState<Note[]>([])
  const [start, setStart] = useState<number | undefined>(undefined)
  const [ready, setReady] = useState(false)
  const [toast, setToast] = useState<{ msg: string; kind: 'ok' | 'info' } | null>(null)
  const [doubtFor, setDoubtFor] = useState<Note | null>(null)
  const [starred, setStarred] = useState(false)
  const [pop, setPop] = useState(false)
  const askedTab = (useLocation().state as { tab?: string } | null)?.tab
  // While the map is open and the video plays, its current idea is lit (checked every 2 s, nothing stored).
  const [nowS, setNowS] = useState<number | null>(null)
  const [tab, setTab] = useState<'notes' | 'map' | 'mine'>(askedTab === 'map' ? 'map' : askedTab === 'mine' ? 'mine' : 'notes')
  const [padVersion, setPadVersion] = useState(0) // bumps when a copy changes the saved notepad
  // The editor opens only once their saved notes are in: a blank editor could save over them.
  const [padState, setPadState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [aboutOpen, setAboutOpen] = useState(false)
  const [commentsOpen, setCommentsOpen] = useState(false)
  const ai = useAiNotes(videoId)
  const padContent = useRef<string | null>(null)
  // A time tapped in the notebook opens the lecture at that note.
  // A shared link can carry the second too: /watch/<id>?t=<seconds>.
  const loc = useLocation()
  const linkT = Number(new URLSearchParams(loc.search).get('t'))
  const noteAt = (loc.state as { t?: number } | null)?.t ?? (Number.isInteger(linkT) && linkT > 0 ? linkT + 5 : undefined)

  useEffect(() => {
    openLecture(videoId)
      .then((d) => {
        setMissing(!!d.missing)
        setData(d)
        setNotes(d.notes)
        setStarred(!!d.starred)
        padContent.current = d.notepad?.content ?? null
        setPadState('ready')
        setStart(noteAt !== undefined ? Math.max(0, noteAt - 5) : d.position_s > 15 ? d.position_s : undefined)
      })
      .catch(() => {
        setData({ video: null, position_s: 0, notes: [] })
        setPadState('failed')
      })
      .finally(() => setReady(true))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open once per lecture
  }, [videoId])

  const onReady = useCallback((p: YTPlayer) => {
    player.current = p
  }, [])

  const now = () => Math.floor(player.current?.getCurrentTime() ?? 0)

  // Save where the user is every 15 s while playing, and when the user leaves (resume next time).
  useEffect(() => {
    const save = () => {
      const p = player.current
      if (p && p.getCurrentTime() > 5) saveProgress(videoId, Math.floor(p.getCurrentTime())).catch(() => {})
    }
    const timer = window.setInterval(() => {
      if (player.current?.getPlayerState() === 1) save()
    }, PROGRESS_EVERY_MS)
    const onHide = () => document.visibilityState === 'hidden' && save()
    document.addEventListener('visibilitychange', onHide)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onHide)
      save()
    }
  }, [videoId])

  // A short message over the bottom of the page (never over the player). 'info' = not done (no tick).
  const toastTimer = useRef(0)
  const flash = (msg: string, kind: 'ok' | 'info' = 'ok') => {
    setToast({ msg, kind })
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 3000)
  }

  const upsert = (n: Note) =>
    setNotes((all) => [...all.filter((x) => x.id !== n.id), n].sort((a, b) => a.t_seconds - b.t_seconds))

  // A mark at 0:00 before the video has started is almost always a mistake (UX review).
  const notStarted = () => {
    const p = player.current
    if (!p) return true
    const state = p.getPlayerState()
    return p.getCurrentTime() < 1 && state !== 1 && state !== 2
  }

  const mark = useCallback(async () => {
    if (notStarted()) return flash('Press play first, then Mark the moment.', 'info')
    try {
      const n = await addNote({ video_id: videoId, t_seconds: now() })
      upsert(n)
      flash(`Marked at ${clock(n.t_seconds)}`)
    } catch {
      flash('Couldn’t save that mark. Check your connection and try again.', 'info')
    }
  }, [videoId])

  // Star the whole video: it goes to Library → Starred. The icon fills at once; the server catches up.
  const toggleStar = useCallback(async () => {
    const next = !starred
    setStarred(next)
    setPop(true)
    window.setTimeout(() => setPop(false), 400)
    flash(next ? 'Starred. Find it in Library → Starred.' : 'Removed from Starred.')
    try {
      await starVideo(videoId, next)
    } catch {
      setStarred(!next)
      flash('Couldn’t save the star. Try again.', 'info')
    }
  }, [starred, videoId])

  const doubt = useCallback(async () => {
    if (notStarted()) return flash('Press play first, then tap Doubt at the confusing part.', 'info')
    try {
      const n = await addNote({ video_id: videoId, t_seconds: now(), kind: 'doubt' })
      upsert(n)
      setDoubtFor(n)
      flash(`Doubt parked at ${clock(n.t_seconds)}. Write it below, or keep going.`)
    } catch {
      flash('Couldn’t save that doubt. Check your connection and try again.', 'info')
    }
  }, [videoId])

  const back10 = () => player.current?.seekTo(Math.max(0, now() - 10), true)
  const jump = (t: number) => {
    player.current?.seekTo(Math.max(0, t), true)
    player.current?.playVideo()
  }

  // Laptop shortcuts: N = mark, D = doubt, S = star the video, P = My notes (not while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el.closest('input, textarea, select, [contenteditable]') || e.ctrlKey || e.metaKey || e.altKey) return
      const key = e.key.toLowerCase()
      if (key === 'n') mark()
      else if (key === 'd') doubt()
      else if (key === 's') toggleStar()
      else if (key === 'p') setTab('mine')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mark, doubt, toggleStar])

  const empty = notes.filter((n) => n.kind === 'note' && !n.text)
  const shown = notes.filter((n) => n.text || n.kind === 'doubt')
  const title = lectureTitle(data?.video, videoId)

  const notesPanel = (
    <>
      {empty.length > 0 && (
        <div className="tray">
          <p className="tray-head">
            <MapPin size={18} aria-hidden="true" />
            <b>
              {empty.length} mark{empty.length > 1 ? 's' : ''} to fill in
            </b>
          </p>
          <p className="help">Play each one again, then write one line.</p>
          {empty.map((n) => (
            <FillMark key={n.id} note={n} onPlay={() => jump(n.t_seconds - 5)} onSaved={upsert} />
          ))}
        </div>
      )}
      {shown.length === 0 && empty.length === 0 && !doubtFor && (
        <div className="empty">
          <span className="icon-circle">
            <MapPin size={22} aria-hidden="true" />
          </span>
          <p className="help">Tap Mark while you listen. Fill it in at the next pause.</p>
        </div>
      )}
      <ul className="notes">
        {shown.map((n) => (
          <NoteRow
            key={n.id}
            note={n}
            onJump={() => jump(n.t_seconds)}
            onChange={upsert}
            onDelete={async () => {
              await deleteNote(n.id)
              setNotes((all) => all.filter((x) => x.id !== n.id))
            }}
          />
        ))}
      </ul>
    </>
  )

  // "Copy to my notes": add to the saved notepad (works even while the editor isn't open).
  useEffect(() => {
    if (tab !== 'map') return
    const t = window.setInterval(() => {
      const p = player.current
      if (p && p.getPlayerState() === 1) setNowS(Math.floor(p.getCurrentTime()))
    }, 2000)
    return () => window.clearInterval(t)
  }, [tab])

  const copyLines = async (lines: ReturnType<typeof copyLine>[], done: string) => {
    const next = appendToDoc(padContent.current, lines)
    padContent.current = next.content
    setPadVersion((v) => v + 1)
    try {
      await saveNotepad(videoId, next.content, next.text)
      flash(done)
    } catch {
      flash('Couldn’t save to My notes. Check your connection.', 'info')
    }
  }
  const copyToNotes = (heading: string, body: string, seconds: number | null) =>
    copyLines([copyLine(heading, body, seconds)], 'Copied to My notes.')

  const tabs = (
    <div className="study-tabs">
      <div className="tabs" role="tablist" aria-label="Study this video">
        <button role="tab" aria-selected={tab === 'notes'} className={tab === 'notes' ? 'on' : ''} onClick={() => setTab('notes')}>
          <Sparkles size={15} aria-hidden="true" /> Summary
        </button>
        <button role="tab" aria-selected={tab === 'map'} className={tab === 'map' ? 'on' : ''} onClick={() => setTab('map')}>
          <Network size={15} aria-hidden="true" /> Mind map
        </button>
        <button
          role="tab"
          aria-selected={tab === 'mine'}
          className={tab === 'mine' ? 'on' : ''}
          onClick={() => setTab('mine')}
          aria-keyshortcuts="P"
        >
          <NotebookPen size={15} aria-hidden="true" /> My notes
          {shown.length + empty.length > 0 && <span className="count">{shown.length + empty.length}</span>}
        </button>
      </div>
      <div role="tabpanel" className="tab-panel">
        {tab === 'notes' && <AiNotesPanel ai={ai} title={title} videoId={videoId} onSeek={jump} onCopy={copyLines} onToast={flash} />}
        {tab === 'map' && (
          <Suspense fallback={<div className="skeleton" style={{ height: 420 }} aria-busy="true" />}>
            <MindMap ai={ai} title={title} videoId={videoId} onSeek={jump} onCopy={copyToNotes} onToast={flash} onFull={() => player.current?.pauseVideo()} nowS={nowS} />
          </Suspense>
        )}
        {tab === 'mine' && (
          <>
            {padState === 'loading' && <div className="notepad skeleton" style={{ minHeight: 220 }} aria-busy="true" aria-label="Loading your notes" />}
            {padState === 'failed' && (
              <div className="ai-state" role="alert">
                <h3>Couldn’t load your notes</h3>
                <p>Your saved notes are safe. Check your connection and try again.</p>
                <button className="small" onClick={() => window.location.reload()}>
                  Try again
                </button>
              </div>
            )}
            {padState === 'ready' && (
              <Suspense fallback={<div className="notepad skeleton" aria-busy="true" />}>
                <Notepad
                  key={padVersion}
                  videoId={videoId}
                  title={title}
                  initial={padContent.current}
                  onChange={(c) => (padContent.current = c)}
                  getTime={() => player.current?.getCurrentTime() ?? 0}
                  onSeek={jump}
                />
              </Suspense>
            )}
            <h3 className="marks-head">Marks and doubts</h3>
            {notesPanel}
          </>
        )}
      </div>
    </div>
  )

  if (missing)
    return (
      <section className="card empty tint-peach not-found">
        <h1>This video isn’t available</h1>
        <p className="help">The link may be wrong, or the video was removed or made private on YouTube.</p>
        <Link className="button" to="/">
          Go to Home
        </Link>
      </section>
    )

  return (
    <section className="study">
      <div className="study-main">
        <div className="player-wrap">
          {ready ? (
            <Player videoId={videoId} start={start} onReady={onReady} />
          ) : (
            <div className="player-frame" aria-busy="true" />
          )}
        </div>
        {start && (
          <p className="resume-line">
            {noteAt !== undefined
              ? `Opening at your note (${clock(noteAt)}).`
              : `Starting where you stopped (${clock(start)}).`}{' '}
            <button className="link" onClick={() => setStart(undefined)}>
              Start from the beginning
            </button>
          </p>
        )}

        <div className="title-block">
          <div>
            <h1 className="lecture-title">{title}</h1>
            {data?.video && (
              <p className="lecture-channel">
                {[data.video.channel_title, ago(data.video.published_at)].filter(Boolean).join(' · ')}
              </p>
            )}
          </div>
          <div className="title-actions">
          <ShareToGroup videoId={videoId} title={title} getTime={() => player.current?.getCurrentTime() ?? 0} />
          <button
            className={`star-video${starred ? ' on' : ''}${pop ? ' pop' : ''}`}
            onClick={toggleStar}
            aria-pressed={starred}
            aria-keyshortcuts="S"
            title={starred ? 'Starred (in Library)' : 'Star this video'}
          >
            <Star size={20} weight={starred ? 'fill' : 'duotone'} aria-hidden="true" />
            {starred ? 'Starred' : 'Star'}
          </button>
          </div>
        </div>
        <div id="share-slot" />
        <div className="capture" role="toolbar" aria-label="Capture while you watch">
          <button className="mark" onClick={() => mark()} aria-keyshortcuts="N" title="Save this second (N)">
            <span className="ic" aria-hidden="true">
              <MapPin size={19} />
            </span>
            Mark
          </button>
          <button className="doubt" onClick={doubt} aria-keyshortcuts="D" title="Park a doubt (D)">
            <span className="ic" aria-hidden="true">
              <CircleHelp size={19} />
            </span>
            Doubt
          </button>
          <button className="back" onClick={back10} title="Back 10 seconds">
            <span className="ic" aria-hidden="true">
              <RotateCcw size={19} />
            </span>
            −10s
          </button>
        </div>
        {/* Right under the buttons, on any tab: tapping Doubt must visibly ask what it is about. */}
        {doubtFor && (
          <DoubtLine
            note={doubtFor}
            onSaved={(n) => {
              upsert(n)
              setDoubtFor(null)
              flash('Doubt saved. It’s in My notes, under Marks and doubts.')
            }}
            onClose={() => setDoubtFor(null)}
          />
        )}
        {toast && (
          <p className={`toast ${toast.kind}`} role="status">
            {toast.kind === 'ok' ? <Check size={16} aria-hidden="true" /> : <Info size={16} aria-hidden="true" />} {toast.msg}
          </p>
        )}

      </div>

      <div className="study-side">
        {!notesOf(ai.view) && <StudyHint />}
        {tabs}
        <p className="attribution">
          Video plays from YouTube.{' '}
          <a href={`https://www.youtube.com/watch?v=${videoId}`} rel="noopener">
            Watch on YouTube
          </a>
        </p>
      </div>

      <div className="study-more">
        <details className="fold" onToggle={(e) => e.currentTarget.open && setAboutOpen(true)}>
          <summary>
            <AlignLeft size={16} aria-hidden="true" /> Description
          </summary>
          {aboutOpen && <Description text={data?.description ?? ''} onSeek={jump} />}
        </details>
        <details className="fold" onToggle={(e) => e.currentTarget.open && setCommentsOpen(true)}>
          <summary>
            <MessageSquare size={16} aria-hidden="true" /> Comments
          </summary>
          {commentsOpen && <Comments videoId={videoId} onSeek={jump} />}
        </details>
      </div>
    </section>
  )
}

function TagPicker({ value, onPick }: { value: Tag | null; onPick: (t: Tag | null) => void }) {
  return (
    <div className="tags" role="group" aria-label="Type">
      {TAGS.map((t) => (
        <button
          key={t.id}
          className={`tag-btn${value === t.id ? ' on' : ''}`}
          aria-pressed={value === t.id}
          onClick={() => onPick(value === t.id ? null : t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

function FillMark({ note, onPlay, onSaved }: { note: Note; onPlay: () => void; onSaved: (n: Note) => void }) {
  const [text, setText] = useState('')
  const [tag, setTag] = useState<Tag | null>(null)
  const save = async () => {
    if (!text.trim()) return
    onSaved(await updateNote({ id: note.id, text, ...(tag ? { tag } : {}) }))
  }
  return (
    <div className="fill">
      <div className="row">
        <button
          className="time-chip"
          style={{ alignSelf: 'center' }}
          onClick={onPlay}
          aria-label={`Play again from ${clock(Math.max(0, note.t_seconds - 5))}`}
        >
          ▶ {clock(note.t_seconds)}
        </button>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && save()}
          placeholder="One line: what was this?"
          aria-label={`Note at ${clock(note.t_seconds)}`}
        />
      </div>
      <div className="row">
        <TagPicker value={tag} onPick={setTag} />
        <button className="small" onClick={save} disabled={!text.trim()}>
          Save
        </button>
      </div>
    </div>
  )
}

function DoubtLine({ note, onSaved, onClose }: { note: Note; onSaved: (n: Note) => void; onClose: () => void }) {
  const [text, setText] = useState('')
  useBackToClose(true, onClose) // Back = "Later", not leaving the video
  const [failed, setFailed] = useState(false)
  const save = async (e: FormEvent) => {
    e.preventDefault()
    if (!text.trim()) return
    try {
      onSaved(await updateNote({ id: note.id, text }))
    } catch {
      setFailed(true)
    }
  }
  return (
    <form className="fill doubt-line" onSubmit={save}>
      <label htmlFor="doubt-text">
        Doubt at {clock(note.t_seconds)}: what didn’t make sense? <span className="help">(optional)</span>
      </label>
      <div className="row">
        <input
          id="doubt-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="e.g. Is a Section 8 company covered?"
          autoComplete="off"
        />
        <button type="submit" className="small" disabled={!text.trim()}>
          Save
        </button>
        <button type="button" className="link" onClick={onClose}>
          Later
        </button>
      </div>
      {failed && (
        <p className="error" role="alert">
          Couldn’t save it. Check your connection and tap Save again.
        </p>
      )}
    </form>
  )
}

function NoteRow({
  note,
  onJump,
  onChange,
  onDelete,
}: {
  note: Note
  onJump: () => void
  onChange: (n: Note) => void
  onDelete: () => void
}) {
  const confirm = useConfirmTap()
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(note.text)
  const [answer, setAnswer] = useState(note.answer)
  const isDoubt = note.kind === 'doubt'
  return (
    <li className={`note${isDoubt ? ' is-doubt' : ''}`}>
      <button className="time-chip" onClick={onJump} aria-label={`Jump to ${clock(note.t_seconds)}`}>
        {clock(note.t_seconds)}
      </button>
      <div className="note-body">
        <div className="note-head">
          {isDoubt && (
            <span className={`badge ${note.solved ? 'good' : 'bad'}`}>{note.solved ? 'Doubt · solved' : 'Doubt'}</span>
          )}
          {note.tag && <span className={`badge tag-${note.tag}`}>{tagLabel(note.tag)}</span>}
          <button
            className={`star${note.starred ? ' on' : ''}`}
            aria-pressed={note.starred}
            aria-label="Important"
            title="Mark as important"
            onClick={async () => {
              const next = !note.starred
              onChange({ ...note, starred: next }) // fill at once; the server catches up
              try {
                onChange(await updateNote({ id: note.id, starred: next }))
              } catch {
                onChange({ ...note, starred: !next })
              }
            }}
          >
            <Star size={18} weight={note.starred ? 'fill' : 'regular'} aria-hidden="true" />
          </button>
        </div>
        {editing ? (
          <div className="row">
            <input value={text} onChange={(e) => setText(e.target.value)} aria-label="Edit note" />
            <button
              className="small"
              onClick={async () => {
                onChange(await updateNote({ id: note.id, text }))
                setEditing(false)
              }}
            >
              Save
            </button>
          </div>
        ) : (
          <p
            className="note-text editable"
            role="button"
            tabIndex={0}
            title="Tap to edit"
            onClick={() => setEditing(true)}
            onKeyDown={(e) => e.key === 'Enter' && setEditing(true)}
          >
            {note.text || <span className="help">(no text yet)</span>}
          </p>
        )}
        {isDoubt && note.answer && <p className="answer">Answer: {note.answer}</p>}
        {isDoubt && !note.solved && (
          <div className="row">
            <input
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              placeholder="Found the answer? Write it here"
              aria-label="Doubt answer"
            />
            <button
              className="small secondary"
              onClick={async () => onChange(await updateNote({ id: note.id, solved: true, answer }))}
            >
              <Check size={15} aria-hidden="true" /> Solved
            </button>
          </div>
        )}
        <div className="note-actions">
          {editing && (
            <button onClick={() => setEditing(false)}>
              <Pencil size={14} aria-hidden="true" /> Cancel
            </button>
          )}
          <button
            className={`del${confirm.armed ? ' armed' : ' icon-only'}`}
            onClick={() => confirm.tap('del', onDelete)}
            aria-label={confirm.armed ? 'Tap again to delete' : 'Delete note'}
            title="Delete note"
          >
            <Trash2 size={15} aria-hidden="true" />
            {confirm.armed && ' Tap again to delete'}
          </button>
        </div>
      </div>
    </li>
  )
}

// Tap the words to hide; the card asks them to recall them (their own words only).

// One-time hint on the first study page (plan v3: first-time guide).
function StudyHint() {
  const KEY = 'focuslearn.studyHintSeen'
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(KEY) !== '1'
    } catch {
      return false
    }
  })
  if (!open) return null
  return (
    <div className="study-hint" role="note">
      <Sparkles size={18} aria-hidden="true" />
      <p>
        Tap <b>Generate summary</b> for a summary of the whole video and a mind map. Your own notes go in <b>My notes</b>.
      </p>
      <button
        className="link"
        onClick={() => {
          try {
            localStorage.setItem(KEY, '1')
          } catch {
            // private mode
          }
          setOpen(false)
        }}
      >
        Got it
      </button>
    </div>
  )
}
