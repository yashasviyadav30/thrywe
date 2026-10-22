import { api } from './api'
import type { VideoCard } from './search'

// Study groups (plan v3, step 4). IDs go in request bodies (R11).
export type Member = { id: number; name: string; owner: boolean; me: boolean }
export type GroupView = { id: string; name: string; invite_code: string; my_name: string; i_own: boolean; members: Member[] }
export type PostKind = 'note' | 'doubt' | 'video' | 'reply'
export type Post = {
  id: string
  kind: PostKind
  author: string
  mine: boolean
  can_delete: boolean
  answered?: boolean // doubts: the asker or the owner closed it
  can_answer?: boolean
  reported: boolean
  text: string
  video_id: string | null
  video: VideoCard | null
  t_seconds: number | null
  attach: 'notes' | 'map' | null
  replies: number
  created_at: string
}
export type GroupSummary = { id: string; name: string; members: number; unread: number; last: string }
export type NewPost = { group_id: string; kind: 'note' | 'doubt' | 'video'; text?: string; video_id?: string; t_seconds?: number; attach?: 'notes' | 'map' }

const post = <T,>(path: string, body: unknown) => api<T>(path, { method: 'POST', body: JSON.stringify(body) })

export const myGroups = () => api<{ groups: GroupSummary[]; unread: number }>('/api/groups')
export const createGroup = (name: string, my_name: string) => post<GroupView>('/api/groups', { name, my_name })
export const previewInvite = (code: string) =>
  post<{ id: string; name: string; members: number; full: boolean; member: boolean }>('/api/groups/preview', { code })
export const joinGroup = (code: string, my_name: string) => post<GroupView>('/api/groups/join', { code, my_name })
export const openGroup = (group_id: string) => post<GroupView & { posts: Post[] }>('/api/groups/open', { group_id })
export const addPost = (p: NewPost) => post<Post>('/api/groups/post', p)
export const getThread = (post_id: string) => post<{ post: Post; replies: Post[] }>('/api/groups/thread', { post_id })
export const addReply = (post_id: string, text: string) => post<Post>('/api/groups/reply', { post_id, text })
export const deletePost = (post_id: string) => post<void>('/api/groups/post/delete', { post_id })
export const markAnswered = (post_id: string, answered: boolean) => post<void>('/api/groups/post/answered', { post_id, answered })
export const reportPost = (post_id: string) => post<void>('/api/groups/report', { post_id })
export const leaveGroup = (group_id: string) => post<void>('/api/groups/leave', { group_id })
export const removeMember = (group_id: string, member_id: number) => post<void>('/api/groups/remove', { group_id, member_id })

export const inviteUrl = (code: string) => `${window.location.origin}/join/${code}`

// Share sheet on phones (WhatsApp is there), copy elsewhere, WhatsApp link as the last resort.
export async function shareInvite(name: string, code: string): Promise<'shared' | 'copied' | 'whatsapp'> {
  const url = inviteUrl(code)
  const text = `Join my study group “${name}”: ${url}`
  if (navigator.share) {
    try {
      await navigator.share({ title: name, text })
      return 'shared'
    } catch (e) {
      if ((e as Error).name === 'AbortError') return 'shared'
    }
  }
  try {
    await navigator.clipboard.writeText(text)
    return 'copied'
  } catch {
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener')
    return 'whatsapp'
  }
}

// An invite opened while signed out waits on this device until the user signs in or signs up.
const PENDING = 'focuslearn.pendingJoin'
export function rememberJoin(code: string) {
  try {
    localStorage.setItem(PENDING, code)
  } catch {
    // private mode: the user can open the link again after signing in
  }
}
export function pendingJoin(): string | null {
  try {
    return localStorage.getItem(PENDING)
  } catch {
    return null
  }
}
// A shared video or group link opened while signed out: back there right after signing in or up.
const AFTER = 'focuslearn.afterSignIn'
const RETURNABLE = /^\/(watch\/[A-Za-z0-9_-]{11}(\?t=\d{1,6})?|groups\/[A-Za-z0-9-]{8,40})$/
export function rememberReturn(path: string) {
  if (!RETURNABLE.test(path)) return
  try {
    localStorage.setItem(AFTER, path)
  } catch {
    // private mode: they open the link again
  }
}
// Where to go once signed in. Only read here (safe while drawing a screen); used up by clearAfterSignIn once
// the signed-in app is showing, so the sign-in page and the redirect can't race for it.
export function peekAfterSignIn(): string {
  const code = pendingJoin()
  if (code) return `/join/${code}`
  let after: string | null = null
  try {
    after = localStorage.getItem(AFTER)
  } catch {
    // ignore
  }
  return after && RETURNABLE.test(after) ? after : '/'
}
export function clearAfterSignIn() {
  try {
    localStorage.removeItem(PENDING)
    localStorage.removeItem(AFTER)
  } catch {
    // ignore
  }
}

// The name the user used last time, offered again for the next group.
const NAME = 'focuslearn.groupName'
export function lastName(): string {
  try {
    return localStorage.getItem(NAME) ?? ''
  } catch {
    return ''
  }
}
export function keepName(n: string) {
  try {
    localStorage.setItem(NAME, n)
  } catch {
    // ignore
  }
}

export function relTime(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  const d = Math.floor(s / 86400)
  return d < 30 ? `${d} day${d === 1 ? '' : 's'} ago` : new Date(iso).toLocaleDateString()
}
