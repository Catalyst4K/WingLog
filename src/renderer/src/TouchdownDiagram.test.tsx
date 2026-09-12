import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { LandingRunway } from '@shared/ipc'
import { TouchdownDiagram } from './TouchdownDiagram'

const RUNWAY: LandingRunway = {
  ident: '27L',
  lengthM: 3800,
  widthM: 60,
  displacedThresholdM: 0,
  aimingPointDistanceM: 400
}

describe('TouchdownDiagram', () => {
  it('renders an accessible label naming the runway', () => {
    render(
      <TouchdownDiagram
        runway={RUNWAY}
        touchdown={{ distanceFromThresholdM: 350, centrelineOffsetM: 4, groundSpeedMs: 60 }}
        unit="ft"
      />
    )
    expect(screen.getByRole('img', { name: /27L/ })).toBeInTheDocument()
  })

  it('shows the distance/offset caption formatted in the chosen unit', () => {
    render(
      <TouchdownDiagram
        runway={RUNWAY}
        touchdown={{ distanceFromThresholdM: 350, centrelineOffsetM: 4, groundSpeedMs: 60 }}
        unit="ft"
      />
    )
    // 350m -> ~1148 ft; 4m right -> ~13 ft R.
    expect(screen.getByText(/1,148 ft from threshold/)).toBeInTheDocument()
    expect(screen.getByText(/13 ft R/)).toBeInTheDocument()
  })

  it('renders a touchdown dot even when the offset is past the runway edge', () => {
    const { container } = render(
      <TouchdownDiagram
        runway={RUNWAY}
        touchdown={{ distanceFromThresholdM: 350, centrelineOffsetM: 200, groundSpeedMs: 60 }}
        unit="m"
      />
    )
    expect(container.querySelector('circle')).not.toBeNull()
  })

  it('draws the displaced-threshold indicator only when the runway has one', () => {
    const undisplaced = render(
      <TouchdownDiagram
        runway={RUNWAY}
        touchdown={{ distanceFromThresholdM: 350, centrelineOffsetM: 0, groundSpeedMs: 60 }}
        unit="m"
      />
    )
    // The displaced-threshold line uses this distinctive dash pattern; the centreline uses
    // a different one, so this only matches when a displaced section is actually drawn.
    expect(undisplaced.container.querySelector('line[stroke-dasharray="6 4"]')).toBeNull()

    const displaced = render(
      <TouchdownDiagram
        runway={{ ...RUNWAY, displacedThresholdM: 200 }}
        touchdown={{ distanceFromThresholdM: 350, centrelineOffsetM: 0, groundSpeedMs: 60 }}
        unit="m"
      />
    )
    expect(displaced.container.querySelector('line[stroke-dasharray="6 4"]')).not.toBeNull()
  })
})
