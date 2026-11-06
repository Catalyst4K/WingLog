import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { Waypoint } from '@shared/route'
import { RouteProfile } from './RouteProfile'

const wp = (ident: string, lon: number, altitudeFt: number): Waypoint => ({
  ident,
  lon,
  lat: 0,
  altitudeFt,
  segment: 'enroute'
})
const ROUTE = [wp('EGLL', 0, 83), wp('LAM', 1, 9000), wp('TOC', 3, 35000), wp('KJFK', 6, 13)]

describe('RouteProfile', () => {
  it('draws the plan as a dashed magenta line, with the highest level and the length beside its title', () => {
    render(<RouteProfile waypoints={ROUTE} aircraft={null} altitudeUnit="ft" />)
    expect(screen.getByText('Route profile')).toBeInTheDocument()
    expect(screen.getByText('35,000 ft · 360 nm')).toBeInTheDocument()
    const plan = screen.getByTestId('route-profile-plan')
    expect(plan).toHaveAttribute('stroke', 'var(--plan)')
    expect(plan).toHaveAttribute('stroke-dasharray', '6 4')
    expect(screen.queryByTestId('route-profile-aircraft')).not.toBeInTheDocument()
  })

  it('puts the aircraft on it in ink, at its place along the route', () => {
    const { rerender } = render(
      <RouteProfile waypoints={ROUTE} aircraft={{ lon: 1.1, lat: 0, altitudeFt: 9500 }} altitudeUnit="ft" />
    )
    const early = Number(screen.getByTestId('route-profile-aircraft').getAttribute('cx'))
    rerender(
      <RouteProfile waypoints={ROUTE} aircraft={{ lon: 5.9, lat: 0, altitudeFt: 4000 }} altitudeUnit="ft" />
    )
    const late = Number(screen.getByTestId('route-profile-aircraft').getAttribute('cx'))
    expect(late).toBeGreaterThan(early)
    expect(screen.getByTestId('route-profile-aircraft')).toHaveAttribute('fill', 'var(--foreground)')
  })

  it('writes the height in the chosen unit', () => {
    render(<RouteProfile waypoints={ROUTE} aircraft={null} altitudeUnit="m" />)
    expect(screen.getByText('10,668 m · 360 nm')).toBeInTheDocument()
  })

  it('draws nothing for a route with no altitude to show', () => {
    const flat = [wp('A', 0, 0), wp('B', 1, 0), wp('C', 2, 0)]
    const { container } = render(<RouteProfile waypoints={flat} aircraft={null} altitudeUnit="ft" />)
    expect(container).toBeEmptyDOMElement()
    expect(
      render(<RouteProfile waypoints={[]} aircraft={null} altitudeUnit="ft" />).container
    ).toBeEmptyDOMElement()
  })
})
