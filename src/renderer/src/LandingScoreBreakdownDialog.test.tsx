import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { LandingScoreCategory } from '@shared/ipc'
import { LandingScoreBreakdownDialog } from './LandingScoreBreakdownDialog'

function makeCategories(overrides: Partial<Record<string, number | null>> = {}): LandingScoreCategory[] {
  const base: Record<string, number | null> = {
    verticalSpeed: 90,
    gForce: 95,
    pitch: 90,
    bank: 95,
    crab: 90,
    distanceFromAimingPoint: 85,
    centrelineOffset: 90,
    ...overrides
  }
  const labels: Record<string, string> = {
    verticalSpeed: 'Vertical speed',
    gForce: 'G-force',
    pitch: 'Pitch',
    bank: 'Bank',
    crab: 'Crab',
    distanceFromAimingPoint: 'Distance from aiming point',
    centrelineOffset: 'Centreline offset'
  }
  // Real weights (landing-score.ts's WEIGHTS) — matters here since the popup now scales
  // each row's deduction/ceiling by its own weight, not a flat /10 for every row.
  const weights: Record<string, number> = {
    verticalSpeed: 25,
    gForce: 15,
    distanceFromAimingPoint: 20,
    centrelineOffset: 10,
    pitch: 10,
    bank: 10,
    crab: 10
  }
  return Object.keys(base).map((key) => ({
    key: key as LandingScoreCategory['key'],
    label: labels[key],
    score: base[key],
    weight: weights[key]
  }))
}

describe('LandingScoreBreakdownDialog', () => {
  it('opens from its trigger and shows the overall score', async () => {
    const user = userEvent.setup()
    render(
      <LandingScoreBreakdownDialog
        overall={82}
        categories={makeCategories()}
        trigger={<button type="button">View breakdown</button>}
      />
    )
    expect(screen.queryByText(/Landing score breakdown/)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'View breakdown' }))
    expect(screen.getByText('Landing score breakdown — 82/100')).toBeInTheDocument()
  })

  it('shows each category as a deduction against its own weighted ceiling, 0 for a perfect input', async () => {
    const user = userEvent.setup()
    render(
      <LandingScoreBreakdownDialog
        overall={90}
        categories={makeCategories({ verticalSpeed: 100, crab: 30 })}
        trigger={<button type="button">Open</button>}
      />
    )
    await user.click(screen.getByRole('button', { name: 'Open' }))

    // verticalSpeed: weight 25 -> ceiling 2.5, perfect score -> "0" (not scaled)
    const verticalSpeedRow = screen.getByText('Vertical speed').nextElementSibling!
    expect(verticalSpeedRow.textContent).toBe('0 / 2.5')

    // crab: weight 10 -> ceiling 1.0, deduction -(10*(100-30)/1000) = -0.7
    const crabRow = screen.getByText('Crab').nextElementSibling!
    expect(crabRow.textContent).toBe('-0.7 / 1.0')
  })

  it('shows N/A for a category with no runway match, not a fabricated deduction', async () => {
    const user = userEvent.setup()
    render(
      <LandingScoreBreakdownDialog
        overall={70}
        categories={makeCategories({ centrelineOffset: null, distanceFromAimingPoint: null, crab: null })}
        trigger={<button type="button">Open</button>}
      />
    )
    await user.click(screen.getByRole('button', { name: 'Open' }))

    expect(screen.getAllByText('N/A')).toHaveLength(3)
  })

  it('flags a category below the bad threshold with a warning icon, not one just short of perfect', async () => {
    const user = userEvent.setup()
    render(
      <LandingScoreBreakdownDialog
        overall={60}
        categories={makeCategories({ crab: 20, pitch: 90 })}
        trigger={<button type="button">Open</button>}
      />
    )
    await user.click(screen.getByRole('button', { name: 'Open' }))

    const crabRow = screen.getByText('Crab').closest('dt')!
    const pitchRow = screen.getByText('Pitch').closest('dt')!
    expect(crabRow.querySelector('svg')).not.toBeNull()
    expect(pitchRow.querySelector('svg')).toBeNull()
  })
})
