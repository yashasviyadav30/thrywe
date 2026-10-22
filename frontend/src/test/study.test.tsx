import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clock, notebookMarkdown, type Note } from '../lib/study'
import { renderAt, signInForTest } from './render'

const VID = 'lecture0001'
const VIDEO = { video_id: VID, title: 'ESG Lecture 6', channel_id: 'c', channel_title: 'CS Teacher', thumbnail_url: '', duration_s: 4000, published_at: null, live: 'none', has_captions: true }

function note(over: Partial<Note> = {}): Note {
  return { id: 'n1', video_id: VID, t_seconds: 2530, kind: 'note', tag: null, starred: false, text: '', solved: false, answer: '', cards: 0, created_at: '2026-10-01T10:00:00Z', ...over }
}

// A stand-in for the YouTube player: records options, reports a fixed time.
function fakeYouTube(currentTime = 2530, state = 2) {
  const created: Array<Record<string, unknown>> = []
  const seeks: number[] = []
  window.YT = {
    Player: class {
      constructor(_el: HTMLElement, opts: Record<string, unknown>) {
        created.push(opts)
        const events = opts.events as { onReady: (e: { target: unknown }) => void }
        setTimeout(() => events.onReady({ target: this }))
      }
      destroy() {}
      seekTo(s: number) {
        seeks.push(s)
      }
      getCurrentTime() {
        return currentTime
      }
      getPlayerState() {
        return state
      }
      playVideo() {}
      pauseVideo() {}
    },
  }
  return { created, seeks }
}

afterEach(() => {
  delete window.YT
  vi.restoreAllMocks()
})

describe('study page', () => {
  it('marks the current second in one tap, then fills it in later', async () => {
    const yt = fakeYouTube()
    const { calls } = signInForTest({
      'POST /api/study/open': () => ({ status: 200, body: { video: VIDEO, position_s: 0, notes: [] } }),
      'POST /api/notes': () => ({ status: 201, body: note() }),
      'POST /api/notes/update': () => ({ status: 200, body: note({ text: 'CSR spend = 2% of profit', tag: 'def' }) }),
      'POST /api/progress': () => ({ status: 204 }),
    })
    renderAt(`/watch/${VID}`)
    await waitFor(() => expect(yt.created).toHaveLength(1))
    await userEvent.click(await screen.findByRole('button', { name: /Mark/ }))
    expect(await screen.findByRole('status')).toHaveTextContent('Marked at 42:10')
    expect(calls.find((c) => c.path === '/api/notes')?.body).toMatchObject({ video_id: VID, t_seconds: 2530 })

    await userEvent.click(screen.getByRole('tab', { name: /My notes/ }))
    expect(screen.getByText('1 mark to fill in')).toBeInTheDocument()
    await userEvent.type(screen.getByRole('textbox', { name: 'Note at 42:10' }), 'CSR spend = 2% of profit')
    await userEvent.click(screen.getByRole('button', { name: 'Definition' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('CSR spend = 2% of profit')).toBeInTheDocument()
    expect(calls.find((c) => c.path === '/api/notes/update')?.body).toMatchObject({ text: 'CSR spend = 2% of profit', tag: 'def' })
    expect(screen.queryByText(/to fill in/)).not.toBeInTheDocument()
  })

  it('jumps the player back to a note when its time is tapped', async () => {
    const yt = fakeYouTube()
    signInForTest({
      'POST /api/study/open': () => ({ status: 200, body: { video: VIDEO, position_s: 0, notes: [note({ text: 'BRSR top 1000', t_seconds: 600 })] } }),
      'POST /api/progress': () => ({ status: 204 }),
    })
    renderAt(`/watch/${VID}`)
    await waitFor(() => expect(yt.created).toHaveLength(1))
    await new Promise((r) => setTimeout(r, 0))
    await userEvent.click(await screen.findByRole('tab', { name: /My notes/ }))
    await userEvent.click(await screen.findByRole('button', { name: 'Jump to 10:00' }))
    expect(yt.seeks).toContain(600)
  })

  it('resumes where the user stopped, and can start from the beginning', async () => {
    const yt = fakeYouTube()
    signInForTest({
      'POST /api/study/open': () => ({ status: 200, body: { video: VIDEO, position_s: 2530, notes: [] } }),
      'POST /api/progress': () => ({ status: 204 }),
    })
    renderAt(`/watch/${VID}`)
    await waitFor(() => expect(yt.created).toHaveLength(1))
    expect(yt.created[0].playerVars).toMatchObject({ start: 2530, autoplay: 0, controls: 1 })
    await userEvent.click(screen.getByRole('button', { name: 'Start from the beginning' }))
    await waitFor(() => expect(yt.created).toHaveLength(2))
    expect(yt.created[1].playerVars).not.toHaveProperty('start')
  })

  it('makes AI notes on request, jumps to their times and copies them to My notes', async () => {
    const yt = fakeYouTube()
    const notes = {
      summary: 'What CSR rules say.',
      brief: '## Who spends\n- Companies over 500 crore net worth spend **2%** of profit.',
      points: [{ title: 'Who must spend', seconds: 760, short: 'Big companies spend 2%.', detail: 'Net worth over 500 crore.' }],
      mindmap: [{ id: 'r', parent: null, label: 'CSR', detail: '', seconds: 0 }],
    }
    let made = false
    const { calls } = signInForTest({
      'POST /api/study/open': () => ({ status: 200, body: { video: VIDEO, position_s: 0, notes: [], notepad: null } }),
      'POST /api/ai-notes': (init) => {
        if (JSON.parse(String(init.body)).create) made = true
        return { status: 200, body: made ? { status: 'ready', notes } : { status: 'none' } }
      },
      'POST /api/notepad/save': () => ({ status: 200, body: {} }),
      'POST /api/progress': () => ({ status: 204 }),
    })
    renderAt(`/watch/${VID}`)
    await userEvent.click(await screen.findByRole('button', { name: /Generate summary/ }))
    // The summary shows first; "Detailed summary" opens the long one below it.
    expect(await screen.findByText('What CSR rules say.')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Who spends' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Detailed summary' }))
    expect(screen.getByRole('heading', { name: 'Who spends' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Hide detailed summary' })).toHaveAttribute('aria-expanded', 'true')
    expect(calls.filter((c) => c.path === '/api/ai-notes').map((c) => c.body)).toEqual([
      { video_id: VID, lang: 'en', create: false },
      { video_id: VID, lang: 'en', create: true },
    ])
    expect(screen.getByText(/Made by AI from the video/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Play from 12:40' }))
    expect(yt.seeks).toContain(760)
    await userEvent.click(screen.getByText('Who must spend'))
    await userEvent.click(screen.getByRole('button', { name: /Copy to my notes/ }))
    await userEvent.click(screen.getByRole('menuitem', { name: /^Short/ }))
    await waitFor(() => expect(calls.find((c) => c.path === '/api/notepad/save')?.body).toMatchObject({ video_id: VID, text: '[12:40] Who must spend: Big companies spend 2%.' }))
 
    // Test yourself: the title is the question, the answer stays hidden until asked for; nothing is scored.
    await userEvent.click(screen.getByRole('button', { name: 'Test yourself' }))
    expect(screen.queryByText('Big companies spend 2%.')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Show answer' }))
    expect(screen.getByText('Big companies spend 2%.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Back to reading' }))
    await userEvent.click(screen.getByRole('button', { name: /Copy all/ }))
    await userEvent.click(screen.getByRole('menuitem', { name: /Key points in full/ }))
    expect(await screen.findByText('Copied 1 key point to My notes.')).toBeInTheDocument()
    await waitFor(() => expect((calls.filter((c) => c.path === '/api/notepad/save').at(-1)?.body as { text?: string } | undefined)?.text).toContain('Big companies spend 2%. Net worth over 500 crore.'))
  })

  it('never puts the video ID in a URL (R11)', async () => {
    const yt = fakeYouTube()
    const { calls } = signInForTest({
      'POST /api/study/open': () => ({ status: 200, body: { video: VIDEO, position_s: 0, notes: [] } }),
      'POST /api/notes': () => ({ status: 201, body: note({ kind: 'doubt' }) }),
      'POST /api/progress': () => ({ status: 204 }),
    })
    renderAt(`/watch/${VID}`)
    await waitFor(() => expect(yt.created).toHaveLength(1))
    await new Promise((r) => setTimeout(r, 0)) // let the player report ready
    await userEvent.click(await screen.findByRole('button', { name: /Doubt/ }))
    expect(await screen.findByText(/Doubt parked at 42:10/)).toBeInTheDocument()
    // The box to write it opens under the buttons even though the Summary tab is showing.
    expect(screen.getByLabelText(/Doubt at 42:10: what didn’t make sense/)).toBeVisible()
    expect(calls.length).toBeGreaterThan(1)
    for (const c of calls) expect(c.path).not.toContain(VID)
  })
})

it('asks to press play before marking at 0:00', async () => {
  const yt = fakeYouTube(0, -1) // not started yet
  const { calls } = signInForTest({
    'POST /api/study/open': () => ({ status: 200, body: { video: VIDEO, position_s: 0, notes: [] } }),
    'POST /api/progress': () => ({ status: 204 }),
  })
  renderAt(`/watch/${VID}`)
  await waitFor(() => expect(yt.created).toHaveLength(1))
  await new Promise((r) => setTimeout(r, 0))
  await userEvent.click(screen.getByRole('button', { name: /Mark/ }))
  expect(await screen.findByText(/Press play first/)).toBeInTheDocument()
  expect(calls.some((c) => c.path === '/api/notes')).toBe(false)
})

describe('home and personal', () => {
  it('removes a video from Continue watching with its ✕', async () => {
    const { calls } = signInForTest({
      'GET /api/home/summary': () => ({ status: 200, body: { resume: { video_id: VID, position_s: 2530, video: VIDEO }, cards_due: 0, doubts_open: 0, marks_to_fill: 0, week: { reviews: 0, notes: 0 }, totals: { notes: 0, lectures: 1, cards: 0 } } }),
      'GET /api/goals/active': () => ({ status: 200, body: null }),
      'POST /api/history/remove': () => ({ status: 204 }),
    })
    renderAt('/')
    await userEvent.click(await screen.findByRole('button', { name: 'Remove from Continue watching' }))
    expect(screen.queryByText('Continue watching')).not.toBeInTheDocument()
    expect(calls.find((c) => c.path === '/api/history/remove')?.body).toEqual({ video_id: VID }) // in the body (R11)
  })

  it('opens Home with Continue watching for the last lecture', async () => {
    signInForTest({
      'GET /api/home/summary': () => ({ status: 200, body: { resume: { video_id: VID, position_s: 2530, video: VIDEO }, cards_due: 3, doubts_open: 1, marks_to_fill: 0, week: { reviews: 32, notes: 5 }, totals: { notes: 9, lectures: 2, cards: 4 } } }),
      'GET /api/goals/active': () => ({ status: 200, body: null }),
    })
    renderAt('/')
    expect(await screen.findByRole('link', { name: /ESG Lecture 6/ })).toHaveAttribute('href', `/watch/${VID}`)
    expect(screen.queryByText(/card/i)).not.toBeInTheDocument() // revision cards are gone (plan v3)
  })

  it('searches their notes and filters doubts, all in the request body', async () => {
    const book = { lectures: [{ video_id: VID, video: VIDEO, notes: [note({ kind: 'doubt', text: 'What is XBRL?' })] }], total: 1 }
    const { calls } = signInForTest({ 'POST /api/notebook': () => ({ status: 200, body: book }) })
    renderAt('/personal')
    expect(await screen.findByText(/What is XBRL\?/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Doubts' }))
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search your notes' }), 'xbrl')
    // Searches as the user types, after a short pause.
    await waitFor(() => expect(calls.filter((c) => c.path === '/api/notebook').at(-1)?.body).toEqual({ q: 'xbrl', only: 'doubts' }))
  })

  it('exports notes as Markdown with links back to YouTube', () => {
    const md = notebookMarkdown({ lectures: [{ video_id: VID, video: VIDEO, notes: [note({ text: 'CSR = 2%', starred: true, tag: 'def' })] }], total: 1 })
    expect(md).toContain('## ESG Lecture 6')
    expect(md).toContain(`[42:10](https://www.youtube.com/watch?v=${VID}&t=2530s) ★ **DEF** CSR = 2%`)
    expect(clock(3725)).toBe('1:02:05')
  })
})
