import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { LandingScoreCategory } from '@shared/ipc'
import { LandingScoreBreakdownDialog } from './LandingScoreBreakdownDialog'

const IDEAL_TOLERANCE: Record<string, { ideal: number; tolerance: number }> = {
  verticalSpeed: { ideal: 130, tolerance: 390 },
  gForce: { ideal: 1, tolerance: 1 },
  pitch: { ideal: -4, tolerance: 8 },
  bank: { ideal: 0, tolerance: 8 },
  crab: { ideal: 0, tolerance: 9 },
  distanceFromAimingPoint: { ideal: 0, tolerance: 400 },
  centrelineOffset: { ideal: 0, tolerance: 12.5 }
}

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
  return Object.keys(base).map((key) => ({
    key: key as LandingScoreCategory['key'],
    label: labels[key],
    score: base[key],
    ideal: base[key] === null ? null : IDEAL_TOLERANCE[key].ideal,
    tolerance: base[key] === null ? null : IDEAL_TOLERANCE[key].tolerance
  }))
}

describe('LandingScoreBreakdownDialog', () => {
  it('opens from its trigger and shows the overall score', async () => {
    const user = userEvent.setup()
    render(
      <LandingScoreBreakdownDialog
        overall={82}
        categories={makeCategories()}
        unit="ft"
        trigger={<button type="button">View breakdown</button>}
      />
    )
    expect(screen.queryByText(/Landing score breakdown/)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'View breakdown' }))
    expect(screen.getByText('Landing score breakdown — 82/100')).toBeInTheDocument()
  })

  it('shows each category as a plain rating out of 10, not a weighted deduction', async () => {
    const user = userEvent.setup()
    render(
      <LandingScoreBreakdownDialog
        overall={90}
        categories={makeCategories({ verticalSpeed: 100, crab: 30 })}
        unit="ft"
        trigger={<button type="button">Open</button>}
      />
    )
    await user.click(screen.getByRole('button', { name: 'Open' }))

    const verticalSpeedRow = screen.getByText('Vertical speed').closest('dt')!.nextElementSibling!
    expect(verticalSpeedRow.textContent).toBe('10 / 10')

    const crabRow = screen.getByText('Crab').closest('dt')!.nextElementSibling!
    expect(crabRow.textContent).toBe('3 / 10') // 30 -> round(30/10) = 3
  })

  it('shows N/A for a category with no runway match, not a fabricated deduction', async () => {
    const user = userEvent.setup()
    render(
      <LandingScoreBreakdownDialog
        overall={70}
        categories={makeCategories({ centrelineOffset: null, distanceFromAimingPoint: null, crab: null })}
        unit="ft"
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
        unit="ft"
        trigger={<button type="button">Open</button>}
      />
    )
    await user.click(screen.getByRole('button', { name: 'Open' }))

    const crabRow = screen.getByText('Crab').closest('dt')!
    const pitchRow = screen.getByText('Pitch').closest('dt')!
    expect(crabRow.querySelector('svg.text-destructive')).not.toBeNull()
    expect(pitchRow.querySelector('svg.text-destructive')).toBeNull()
  })

  it("opens a per-category info popover showing that flight's real ideal/tolerance", async () => {
    const user = userEvent.setup()
    render(
      <LandingScoreBreakdownDialog
        overall={90}
        categories={makeCategories()}
        unit="m"
        trigger={<button type="button">Open</button>}
      />
    )
    await user.click(screen.getByRole('button', { name: 'Open' }))
    expect(screen.queryByText(/aiming-point distance from the threshold/)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: "What's ideal for Distance from aiming point?" }))
    expect(
      screen.getByText(/Score reaches 0 at 400 m off it — this runway's own real aiming-point distance/)
    ).toBeInTheDocument()
  })
})
