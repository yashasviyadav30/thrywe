import { History, Search as SearchIcon, X } from '../components/icons'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useLocation } from 'react-router'
import { peek, remember } from '../lib/api'
import HiddenLine from '../components/HiddenLine'
import VideoItem, { NoticeLine } from '../components/VideoItem'
import { getActiveGoal, type Goal } from '../lib/goals'
import { forgetSearches, recentSearches, rememberSearch, searchVideos, type SearchResponse } from '../lib/search'
import { useVideoActions } from '../lib/useVideoActions'

export default function Search() {
  const handedOver = (useLocation().state as { q?: string } | null)?.q ?? ''
  // Back from a video brings the last results back (kept in memory, never in the URL: R11).
  const kept = handedOver ? undefined : peek<{ query: string; data: SearchResponse }>('search:last')
  const [query, setQuery] = useState(handedOver || kept?.query || '')
  const [data, setData] = useState<SearchResponse | null>(kept?.data ?? null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [showHidden, setShowHidden] = useState(false)
  const [recent, setRecent] = useState(recentSearches)
  const [goal, setGoal] = useState<Goal | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const { actions, visible, notice, undo } = useVideoActions()

  useEffect(() => {
    getActiveGoal()
      .then((g) => setGoal(g && g.id ? g : null))
      .catch(() => setGoal(null))
  }, [])

  const latest = useRef(0) // only the newest search may fill the page
  async function run(q: string, exact = false) {
    const text = q.trim()
    if (!text) return
    const ticket = ++latest.current
    setQuery(text)
    setBusy(true)
    setError(null)
    setShowHidden(false)
    rememberSearch(text)
    setRecent(recentSearches())
    try {
      const found = await searchVideos(text, exact)
      if (ticket === latest.current) setData(remember('search:last', { query: text, data: found }).data)
    } catch (err) {
      if (ticket === latest.current) setError(err instanceof Error ? err.message : 'Search failed. Try again.')
    } finally {
      if (ticket === latest.current) setBusy(false)
    }
  }

  // A search typed in the top bar arrives in memory (never in the URL, R11) and runs straight away.
  useEffect(() => {
    if (handedOver) run(handedOver)
    else if (!kept) input.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handedOver])

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    run(query)
  }

  return (
    <section>
      <h1 className="visually-hidden">Search</h1>
      <form className="search-top" role="search" onSubmit={onSubmit}>
        <label className="field">
          <SearchIcon size={19} aria-hidden="true" />
          <span className="visually-hidden">Search a topic</span>
          <input
            ref={input}
            type="search"
            name="q"
            placeholder="Search a topic…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            enterKeyHint="search"
            autoComplete="off"
          />
        </label>
        <button type="submit" disabled={busy || !query.trim()}>
          {busy ? 'Searching…' : 'Search'}
        </button>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <NoticeLine notice={notice} onUndo={undo} />
      {data?.note && <p className="notice-line">{data.note}</p>}

      {!data && !busy && (
        <>
          {recent.length > 0 && (
            <>
              <div className="ai-head" style={{ justifyContent: 'space-between' }}>
                <h2 className="page-title" style={{ fontSize: '1.05rem' }}>
                  Recent
                </h2>
                <button
                  className="link"
                  onClick={() => {
                    forgetSearches()
                    setRecent([])
                  }}
                >
                  <X size={14} aria-hidden="true" /> Clear
                </button>
              </div>
              <ul className="recent-list">
                {recent.map((q) => (
                  <li key={q}>
                    <button onClick={() => run(q)}>
                      <History size={18} aria-hidden="true" /> {q}
                    </button>
                  </li>
                ))}
              </ul>
              <p className="help">Kept on this device only.</p>
            </>
          )}
          {recent.length === 0 && !goal?.topics.length && (
            <div className="card empty tint-lavender">
              <span className="icon-circle">
                <SearchIcon size={22} aria-hidden="true" />
              </span>
              <h3>What do you want to learn today?</h3>
              <p className="help">A topic, an exam, a skill, a language. Songs and shows stay out of the way.</p>
            </div>
          )}
          {goal && goal.topics.length > 0 && (
            <>
              <h2 className="page-title" style={{ fontSize: '1.05rem' }}>
                Topics for “{goal.text}”
              </h2>
              <div className="chips topic-tiles">
                {goal.topics.map((t) => (
                  <button key={t.id} className="chip" onClick={() => run(t.query)}>
                    {t.name}
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      )}

      {busy && !data && (
        <ul className="vgrid" aria-busy="true" aria-label="Searching">
          {[0, 1, 2, 3].map((i) => (
            <li key={i}>
              <div className="skeleton" style={{ aspectRatio: '16 / 9' }} />
            </li>
          ))}
        </ul>
      )}
      {data && (
        <>
          {data.searched_for && (
            <p className="notice-line search-fixed">
              Showing results for <b>{data.searched_for}</b>.{' '}
              <button className="link" onClick={() => run(query, true)}>
                Search for “{query}” instead
              </button>
            </p>
          )}
          {data.results.length === 0 && (
            <div className="feed-empty">
              <h3>No videos to show for this search</h3>
              <p>Try other words, or tap Show below to see what was hidden.</p>
            </div>
          )}
          <ul className="vgrid" aria-label="Results">
            {data.results.filter(visible).map((v) => (
              <VideoItem key={v.video_id} video={v} progress={data.progress?.[v.video_id]} actions={actions} />
            ))}
            {showHidden &&
              data.hidden.map((v) => (
                <VideoItem key={v.video_id} video={v} hiddenBecause={v.reasons} playable={v.playable} actions={{ onFollow: actions.onFollow }} />
              ))}
          </ul>
          <HiddenLine hidden={data.hidden} shown={showHidden} onToggleShow={() => setShowHidden(!showHidden)} />
        </>
      )}
    </section>
  )
}
