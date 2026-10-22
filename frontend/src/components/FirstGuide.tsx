import { Network, Sparkles, UserPlus } from './icons'
import { useBackToClose } from '../lib/useBackToClose'
import { useEffect, useRef, useState } from 'react'
import { APP_NAME } from '../config'

const KEY = 'focuslearn.guideSeen'
const STEPS = [
  {
    Icon: Sparkles,
    title: `Everything to learn on YouTube, nothing to distract you`,
    text: 'Search anything and watch it here, in YouTube’s own player. Games, comedy, entertainment and songs stay hidden; you choose the rest in Settings.',
  },
  {
    Icon: Network,
    title: 'A summary and a mind map of any video',
    text: 'Open a video and tap Generate summary. You get a summary of the whole video, a brief summary, the key points and a zoomable mind map; tap a time to jump there. Your own notes go in My notes.',
  },
  {
    Icon: UserPlus,
    title: 'Make Home yours',
    text: 'On any video, tap ⋮ to follow its channel, or to say Not interested. Home learns from what you choose.',
  },
]

function seen(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return true // storage blocked: don't show it every time
  }
}

// Three screens on the first visit (plan v3). Shown once per device.
export default function FirstGuide() {
  const [open, setOpen] = useState(() => !seen())
  const [step, setStep] = useState(0)
  const next = useRef<HTMLButtonElement>(null)

  const close = () => {
    try {
      localStorage.setItem(KEY, '1')
    } catch {
      // private mode
    }
    setOpen(false)
  }
  useBackToClose(open, close) // Back closes the guide instead of leaving the app
  useEffect(() => {
    if (!open) return
    next.current?.focus()
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [open, step])

  if (!open) return null
  const { Icon, title, text } = STEPS[step]
  const last = step === STEPS.length - 1
  return (
    <div className="guide-backdrop">
      <div className="guide" role="dialog" aria-modal="true" aria-labelledby="guide-title" aria-describedby="guide-text">
        <span className="icon-circle">
          <Icon size={22} aria-hidden="true" />
        </span>
        <h2 id="guide-title">{title}</h2>
        <p id="guide-text">{text}</p>
        <div className="guide-foot">
          <div className="guide-dots" aria-label={`Step ${step + 1} of ${STEPS.length}`} role="img">
            {STEPS.map((s, i) => (
              <span key={s.title} className={i === step ? 'on' : ''} />
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {!last && (
              <button className="secondary small" onClick={close}>
                Skip
              </button>
            )}
            <button ref={next} className="small" onClick={() => (last ? close() : setStep(step + 1))}>
              {last ? `Start using ${APP_NAME}` : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
