import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { formatDuration, reasonCounts } from '../lib/search'
import { renderAt, signInForTest } from './render'

const card = (id: string, extra = {}) => ({
  video_id: id,
  title: `Lecture ${id}`,
  channel_id: 'UC' + 'a'.repeat(22),
  channel_title: 'Teacher',
  thumbnail_url: 'https://i.ytimg.com/vi/x/mqdefault.jpg',
  duration_s: 1800,
  published_at: null,
  live: 'none',
  has_captions: true,
  ...extra,
})

const RESPONSE = {
  mode: 'live',
  results: [card('lecture0001')],
  hidden: [
    { ...card('musicvid001', { title: 'Song' }), reasons: ['YouTube lists this as Music'], playable: true },
    { ...card('agerestrict', { title: 'Restricted' }), reasons: ['Age-restricted by YouTube'], playable: false },
  ],
  hidden_count: 2,
  searches_left: 90,
  note: null,
}

async function search(q = 'cost accounting') {
  await userEvent.type(await screen.findByLabelText('Search a topic'), q)
  await userEvent.click(screen.getByRole('button', { name: 'Search' }))
}

describe('search (Stage 3)', () => {
  it('says when a typo was fixed, and can search the words as typed', async () => {
    const { calls } = signInForTest({
      'POST /api/search': ({ body }) =>
        ({ status: 200, body: { ...RESPONSE, searched_for: JSON.parse(String(body)).exact ? null : 'cost accounting' } }),
    })
    renderAt('/search')
    await search('cost acounting')
    expect(await screen.findByText(/Showing results for/)).toHaveTextContent('Showing results for cost accounting.')
    await userEvent.click(screen.getByRole('button', { name: 'Search for “cost acounting” instead' }))
    expect(calls.filter((c) => c.path === '/api/search').at(-1)!.body).toEqual({ q: 'cost acounting', exact: true })
    await screen.findByLabelText('Results')
    expect(screen.queryByText(/Showing results for/)).toBeNull()
  })

  it('sends the query in the body, not the URL (R11)', async () => {
    const { calls } = signInForTest({ 'POST /api/search': () => ({ status: 200, body: RESPONSE }) })
    renderAt('/search')
    await search()
    const call = calls.find((c) => c.path === '/api/search')!
    expect(call.method).toBe('POST')
    expect(call.body).toEqual({ q: 'cost accounting' })
  })

  it('keeps the results when coming back from a video, without searching again', async () => {
    const { calls } = signInForTest({
      'POST /api/search': () => ({ status: 200, body: RESPONSE }),
      'POST /api/study/open': () => ({ status: 200, body: { video: null, position_s: 0, notes: [] } }),
    })
    const { router } = renderAt('/search')
    await search()
    await screen.findByRole('list', { name: 'Results' })
    await router.navigate('/watch/lecture0001')
    await router.navigate(-1)
    expect(await screen.findByRole('list', { name: 'Results' })).toBeInTheDocument()
    expect(screen.getByLabelText('Search a topic')).toHaveValue('cost accounting')
    expect(calls.filter((c) => c.path === '/api/search')).toHaveLength(1)
  })

  it('shows results with YouTube’s own title and thumbnail, linking to the watch page', async () => {
    signInForTest({ 'POST /api/search': () => ({ status: 200, body: RESPONSE }) })
    renderAt('/search')
    await search()
    const list = await screen.findByRole('list', { name: 'Results' })
    const link = within(list).getByRole('link', { name: /Lecture lecture0001/ })
    expect(link).toHaveAttribute('href', '/watch/lecture0001')
    expect(list.querySelector('img')).toHaveAttribute('src', 'https://i.ytimg.com/vi/x/mqdefault.jpg')
    expect(within(list).queryByText('Song')).toBeNull()
  })

  it('says the app hid them, explains why, and Show reveals them in place (R6, III.C)', async () => {
    signInForTest({ 'POST /api/search': () => ({ status: 200, body: RESPONSE }) })
    renderAt('/search')
    await search()
    expect(await screen.findByText('2 hidden by Thrywe')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Why' }))
    expect(screen.getByText('1 × YouTube lists this as Music')).toBeInTheDocument()
    expect(screen.getByText('1 × Age-restricted by YouTube')).toBeInTheDocument()
    expect(screen.getByText(/not from YouTube/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Show' }))
    const list = screen.getByRole('list', { name: 'Results' })
    expect(within(list).getByRole('link', { name: /Song/ })).toHaveAttribute('href', '/watch/musicvid001')
    // Unplayable videos are listed with the reason but can't be opened.
    expect(within(list).queryByRole('link', { name: /Restricted/ })).toBeNull()
    expect(within(list).getByText(/Age-restricted by YouTube · Can’t play in this app/)).toBeInTheDocument()
  })

  it('shows the quota note and still works when searches run out (R12)', async () => {
    signInForTest({
      'POST /api/search': () => ({
        status: 200,
        body: { ...RESPONSE, mode: 'cache_stale', note: 'Today’s search limit is used up, so these are saved results from earlier.' },
      }),
    })
    renderAt('/search')
    await search()
    expect(await screen.findByText(/search limit is used up/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Lecture lecture0001/ })).toBeInTheDocument()
  })

  it('hides a channel with one tap', async () => {
    let muted = false
    const { calls } = signInForTest({
      'POST /api/mutes': () => {
        muted = true
        return { status: 201, body: {} }
      },
      'POST /api/search': () => ({ status: 200, body: muted ? { ...RESPONSE, results: [] } : RESPONSE }),
    })
    renderAt('/search')
    await search()
    await userEvent.click((await screen.findAllByRole('button', { name: 'More actions' }))[0])
    await userEvent.click(screen.getByRole('menuitem', { name: 'Don’t show this channel' }))
    expect(await screen.findByText(/won’t see this channel again/)).toBeInTheDocument()
    expect(calls.find((c) => c.path === '/api/mutes')!.body).toEqual({ kind: 'channel', value: 'UC' + 'a'.repeat(22) })
  })

  it('formats durations and groups reasons', () => {
    expect(formatDuration(65)).toBe('1:05')
    expect(formatDuration(3723)).toBe('1:02:03')
    expect(formatDuration(null)).toBe('')
    expect(reasonCounts(RESPONSE.hidden as never)).toEqual([
      ['YouTube lists this as Music', 1],
      ['Age-restricted by YouTube', 1],
    ])
  })
})
