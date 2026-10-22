import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import AuthShell from '../components/AuthShell'
import GoogleButton from '../components/GoogleButton'
import GoogleNewAccount from '../components/GoogleNewAccount'
import { ApiError } from '../lib/api'
import { useSession } from '../lib/session'

export default function SignIn() {
  const { signIn, googleAuth } = useSession()
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [newGoogle, setNewGoogle] = useState<string | null>(null) // Google's answer for an email with no account yet

  async function attempt(work: () => Promise<void>, credential?: string) {
    setBusy(true)
    setError(null)
    try {
      await work() // signed in: PublicLayout now opens the app (or the shared link)
    } catch (err) {
      if (err instanceof ApiError && err.code === 'under_18') return navigate('/not-yet', { replace: true })
      if (credential && err instanceof ApiError && err.code === 'no_account') return setNewGoogle(credential)
      setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  if (newGoogle)
    return (
      <AuthShell title="Welcome to Thrywe" lead="One last step, and you’re in.">
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <GoogleNewAccount
          busy={busy}
          onCreate={(dob) => attempt(() => googleAuth({ credential: newGoogle, date_of_birth: dob, accepted_notice: true }))}
          onCancel={() => setNewGoogle(null)}
        />
      </AuthShell>
    )

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    attempt(() => signIn(String(form.get('email')), String(form.get('password'))))
  }

  return (
    <AuthShell title="Welcome back" lead="Sign in to pick up where you left off.">
      <GoogleButton onCredential={(credential) => attempt(() => googleAuth({ credential }), credential)} />
      <form onSubmit={onSubmit}>
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="email" spellCheck={false} required />
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required />
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <p className="help">
        Forgot your password? If your email is a Gmail address, tap Continue with Google above: it opens the same
        account.
      </p>
      <p>
        New here? <Link to="/sign-up">Create an account</Link>
      </p>
    </AuthShell>
  )
}
