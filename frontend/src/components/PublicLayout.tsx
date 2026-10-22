import { Suspense } from 'react'
import { Link, Navigate, Outlet, useLocation } from 'react-router'
import { APP_NAME } from '../config'
import { readToken } from '../lib/api'
import { peekAfterSignIn } from '../lib/groups'
import { useSession } from '../lib/session'
import Logo from './Logo'
import WakingBanner from './WakingBanner'

// The browser remembers /welcome (everyone's first page) and offers it again when the address is typed or a
// saved link is opened. Someone already signed in skips these pages instead of being asked to sign in again.
const ACCOUNT_PAGES = new Set(['/welcome', '/sign-in', '/sign-up'])

export default function PublicLayout() {
  const { me } = useSession()
  const { pathname } = useLocation()
  const landing = pathname === '/welcome'
  if ((me || readToken()) && ACCOUNT_PAGES.has(pathname)) return <Navigate to={peekAfterSignIn()} replace />
  return (
    <div className={`app${landing ? ' landing-page' : ''}`}>
      <header className="topbar">
        <Link to="/welcome" className="brand-link" aria-label={`${APP_NAME} home`}>
          <Logo size={32} />
        </Link>
        {landing && (
          <nav className="lp-nav" aria-label="Account">
            <Link to="/sign-in">Sign in</Link>
            <Link to="/sign-up" className="button small">
              Start free
            </Link>
          </nav>
        )}
      </header>
      <WakingBanner />
      <main id="main" className="content public">
        <Suspense fallback={<div className="skeleton page-skeleton" aria-busy="true" aria-label="Loading" />}>
          <Outlet />
        </Suspense>
      </main>
    </div>
  )
}
