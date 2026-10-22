import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PartialBanner } from '../components/AiNotesPanel'

const partial = { summary: 'Part one.', points: [], mindmap: [] }

describe('long-video progress line', () => {
  it('counts the minutes read while parts are left', () => {
    render(<PartialBanner view={{ status: 'queued', partial, covered_s: 900, progress: { done: 1, total: 3 } } as never} />)
    expect(screen.getByRole('status')).toHaveTextContent('First 15 minutes ready. Reading the rest: 1 of 3 parts.')
  })

  it('says an older summary is being replaced, so a short one never looks like the final', () => {
    render(<PartialBanner view={{ status: 'ready', notes: partial, updating: true } as never} />)
    expect(screen.getByRole('status')).toHaveTextContent('older, shorter summary')
  })

  it('says the final summary is being written once every part is read (not "first 45 minutes" of a 37-minute video)', () => {
    render(<PartialBanner view={{ status: 'queued', partial, covered_s: 2700, progress: { done: 3, total: 3 } } as never} />)
    expect(screen.getByRole('status')).toHaveTextContent('The whole video is read. Writing the final summary now')
    expect(screen.getByRole('status')).not.toHaveTextContent('45 minutes')
  })
})
