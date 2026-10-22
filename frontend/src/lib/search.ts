import { api } from './api'

export type VideoCard = {
  video_id: string
  title: string
  channel_id: string
  channel_title: string
  thumbnail_url: string
  duration_s: number | null
  published_at: string | null
  live: string
  has_captions: boolean
}

export type HiddenCard = VideoCard & { reasons: string[]; playable: boolean }

// Where the user stopped in each video (seconds), for the red line under the thumbnail.
export type Progress = Record<string, number>

export type SearchResponse = {
  mode: 'live' | 'cache' | 'cache_stale' | 'quota_exhausted'
  results: VideoCard[]
  hidden: HiddenCard[]
  hidden_count: number
  searches_left: number
  note: string | null
  searched_for?: string | null // the search with its typos fixed, when it differs from what was typed
  progress?: Progress
}

// exact: the words as typed, without the typo fix ("Search for … instead").
export function searchVideos(q: string, exact = false): Promise<SearchResponse> {
  // POST so the search text never appears in a URL or request log (R11).
  return api<SearchResponse>('/api/search', { method: 'POST', body: JSON.stringify(exact ? { q, exact } : { q }) })
}

export type FeedResponse = { results: VideoCard[]; hidden: HiddenCard[]; hidden_count: number; progress?: Progress }

// Home feed: followed and recently watched channels, their goal's topics and their recent searches (sent from this
// device; the server never stores search history).
export const getFeed = (recent: string[] = [], only?: 'podcasts') =>
  api<FeedResponse>('/api/feed', { method: 'POST', body: JSON.stringify(only ? { recent, only } : { recent }) })

// Shorts only from channels the user follows.
export const getShorts = () => api<{ results: VideoCard[]; follows: number }>('/api/shorts')

export const notInterested = (video_id: string, undo = false) =>
  api('/api/videos/not-interested', { method: 'POST', body: JSON.stringify({ video_id, undo }) })

// Their last 5 searches, on this device only.
const RECENT_KEY = 'focuslearn.recentSearches'
export function recentSearches(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 5) : []
  } catch {
    return []
  }
}
export function rememberSearch(q: string) {
  const next = [q, ...recentSearches().filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 5)
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    // private mode: nothing remembered
  }
}
export function forgetSearches() {
  try {
    localStorage.removeItem(RECENT_KEY)
  } catch {
    // nothing to forget
  }
}

export function muteChannel(channelId: string) {
  return api('/api/mutes', { method: 'POST', body: JSON.stringify({ kind: 'channel', value: channelId }) })
}

export function unmuteChannel(channelId: string) {
  return api('/api/mutes/remove', { method: 'POST', body: JSON.stringify({ kind: 'channel', value: channelId }) })
}

export const listMutes = () => api<Array<{ kind: string; value: string }>>('/api/mutes')

export function followChannel(channelId: string) {
  return api('/api/follows', { method: 'POST', body: JSON.stringify({ channel_id: channelId }) })
}

// "3 days ago", "2 yr ago": the upload date the way YouTube words it.
export function ago(iso: string | null | undefined): string {
  if (!iso) return ''
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (Number.isNaN(days) || days < 0) return ''
  if (days < 1) return 'today'
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`
  if (days < 365) return `${Math.floor(days / 30)} mo ago`
  return `${Math.floor(days / 365)} yr ago`
}

export function formatDuration(seconds: number | null): string {
  if (seconds == null) return ''
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  const mm = h ? String(m).padStart(2, '0') : String(m)
  return (h ? `${h}:` : '') + `${mm}:${String(s).padStart(2, '0')}`
}

// Groups hidden videos by reason for the "Why" list: [["YouTube lists this as Music", 3], ...].
export function reasonCounts(hidden: HiddenCard[]): Array<[string, number]> {
  const counts = new Map<string, number>()
  for (const h of hidden) for (const r of h.reasons) counts.set(r, (counts.get(r) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1])
}

// One chip above the Home feed, and how its videos load (kept in memory per chip, see `fresh` in api.ts).
export type Chip = { id: string; name: string; query: string | null; only?: 'podcasts' }
export const ALL: Chip = { id: 'all', name: 'All', query: null }
export const feedKey = (chip: Chip) => `feed:${chip.id}`
export const loadFeed = (chip: Chip) => (chip.query ? searchVideos(chip.query) : getFeed(recentSearches(), chip.only))
