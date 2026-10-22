import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import AuthShell from '../components/AuthShell'
import GoogleButton from '../components/GoogleButton'
import GoogleNewAccount from '../components/GoogleNewAccount'
import Notice from '../components/Notice'
import { APP_NAME } from '../config'
import { ApiError } from '../lib/api'
import { useSession } from '../lib/session'

export default function SignUp() {
  const { signUp, googleAuth } = useSession()
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [dob, setDob] = useState('')
  const [notice, setNotice] = useState(false)

  async function attempt(work: () => Promise<void>) {
    setBusy(true)
    setError(null)
    try {
      await work() // signed in: PublicLayout now opens the app (or the shared link)
    } catch (err) {
      if (err instanceof ApiError && err.code === 'under_18') {
        navigate('/not-yet', { replace: true })
        return
      }
      setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  const [pendingGoogle, setPendingGoogle] = useState<string | null>(null)
  function onGoogle(credential: string) {
    if (!dob || !notice) return setPendingGoogle(credential) // keep Google's answer; ask for the last two things
    attempt(() => googleAuth({ credential, date_of_birth: dob, accepted_notice: notice }))
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    attempt(() =>
      signUp({ email: String(form.get('email')), password: String(form.get('password')), date_of_birth: dob, accepted_notice: notice }),
    )
  }

  if (pendingGoogle)
    return (
      <AuthShell title="Create your free account" lead="One last step, and you’re in.">
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <GoogleNewAccount
          busy={busy}
          initialDob={dob}
          onCreate={(d) => attempt(() => googleAuth({ credential: pendingGoogle, date_of_birth: d, accepted_notice: true }))}
          onCancel={() => setPendingGoogle(null)}
        />
      </AuthShell>
    )

  return (
    <AuthShell title="Create your free account" lead="It takes a minute. No card, no ads.">
      <form onSubmit={onSubmit} noValidate={false}>
        <label htmlFor="dob">Date of birth</label>
        <input id="dob" name="dob" type="date" required aria-describedby="dob-help" value={dob} onChange={(e) => setDob(e.target.value)} />
        <p id="dob-help" className="help">
          Used once to check you’re 18 or over. We don’t keep it.
        </p>
        {/* The notice sits right where it is confirmed: open by tapping, so the form isn't buried under it. */}
        <details className="notice-fold">
          <summary>What {APP_NAME} stores, and why</summary>
          <Notice />
        </details>
        <label className="check">
          <input name="notice" type="checkbox" required checked={notice} onChange={(e) => setNotice(e.target.checked)} /> I’ve read what{' '}
          {APP_NAME} stores and why
        </label>
        <GoogleButton onCredential={onGoogle} after="or create an account with email" />
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="email" spellCheck={false} required />
        <label htmlFor="password">Password (at least 8 characters)</label>
        <input id="password" name="password" type="password" autoComplete="new-password" minLength={8} required />
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create account'}
        </button>
      </form>
      <p>
        Already have an account? <Link to="/sign-in">Sign in</Link>
      </p>
    </AuthShell>
  )
}
