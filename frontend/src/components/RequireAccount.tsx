import { useEffect } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router'
import Logo from './Logo'
import { readToken } from '../lib/api'
import { clearAfterSignIn, rememberJoin, rememberReturn } from '../lib/groups'
import { useSession } from '../lib/session'

// Everything except the welcome, sign-up, sign-in and privacy pages needs an account (18+, R10).
export default function RequireAccount() {
  const { me, loading } = useSession()
  const { pathname, search } = useLocation()
  useEffect(() => {
    if (me) clearAfterSignIn() // inside the app now: the remembered link has done its job
  }, [me])
  if (loading)
    return (
      <div className="boot" role="status" aria-busy="true">
        <Logo size={56} />
        <span>Opening Thrywe…</span>
      </div>
    )
  if (!me && readToken()) {
    // Still signed in, but the server couldn't be reached at start (not a sign-out): offer a retry, keep the token.
    return (
      <div className="boot" role="alert">
        <Logo size={56} />
        <span>Can’t reach Thrywe right now.</span>
        <button onClick={() => window.location.reload()}>Try again</button>
      </div>
    )
  }
  if (!me) {
    const invite = pathname.match(/^\/join\/([A-Za-z0-9_-]{8,32})$/)
    if (invite) rememberJoin(invite[1]) // opened an invite while signed out: join right after signing in
    else rememberReturn(pathname + search) // a shared video: open it right after signing in
    return <Navigate to="/welcome" replace />
  }
  return <Outlet />
}
