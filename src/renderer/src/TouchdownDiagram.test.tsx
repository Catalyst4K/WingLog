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
      />
    )
    expect(screen.getByRole('img', { name: /27L/ })).toBeInTheDocument()
  })

  it('renders a touchdown dot even when the offset is past the runway edge', () => {
    const { container } = render(
      <TouchdownDiagram
        runway={RUNWAY}
        touchdown={{ distanceFromThresholdM: 350, centrelineOffsetM: 200, groundSpeedMs: 60 }}
      />
    )
    expect(container.querySelector('circle')).not.toBeNull()
  })

  it('runs vertically — the viewBox is taller than it is wide (Callum, 2026-09-12)', () => {
    const { container } = render(
      <TouchdownDiagram
        runway={RUNWAY}
        touchdown={{ distanceFromThresholdM: 350, centrelineOffsetM: 0, groundSpeedMs: 60 }}
      />
    )
    const svg = container.querySelector('svg')!
    const [, , widthPx, heightPx] = svg.getAttribute('viewBox')!.split(' ').map(Number)
    expect(heightPx).toBeGreaterThan(widthPx)
  })

  it('sizes off height, not width, so it can shrink to fit alongside the field list (Callum, 2026-09-12)', () => {
    const { container } = render(
      <TouchdownDiagram
        runway={RUNWAY}
        touchdown={{ distanceFromThresholdM: 350, centrelineOffsetM: 0, groundSpeedMs: 60 }}
      />
    )
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('height')).toBe('100%')
    expect(svg.getAttribute('width')).toBe('auto')
  })

  it('renders no caption text below the diagram (Callum, 2026-09-12: not necessary)', () => {
    const { container } = render(
      <TouchdownDiagram
        runway={RUNWAY}
        touchdown={{ distanceFromThresholdM: 350, centrelineOffsetM: 4, groundSpeedMs: 60 }}
      />
    )
    expect(container.querySelector('p')).toBeNull()
  })

  it('draws the displaced-threshold indicator only when the runway has one', () => {
    const undisplaced = render(
      <TouchdownDiagram
        runway={RUNWAY}
        touchdown={{ distanceFromThresholdM: 350, centrelineOffsetM: 0, groundSpeedMs: 60 }}
      />
    )
    // The displaced-threshold line uses this distinctive dash pattern; the centreline uses
    // a different one, so this only matches when a displaced section is actually drawn.
    expect(undisplaced.container.querySelector('line[stroke-dasharray="6 4"]')).toBeNull()

    const displaced = render(
      <TouchdownDiagram
        runway={{ ...RUNWAY, displacedThresholdM: 200 }}
        touchdown={{ distanceFromThresholdM: 350, centrelineOffsetM: 0, groundSpeedMs: 60 }}
      />
    )
    expect(displaced.container.querySelector('line[stroke-dasharray="6 4"]')).not.toBeNull()
  })
})
