import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

  it('zooms to the stretch around the aircraft, scaling the height to it', async () => {
    const user = userEvent.setup()
    render(
      <RouteProfile waypoints={ROUTE} aircraft={{ lon: 1, lat: 0, altitudeFt: 9000 }} altitudeUnit="ft" />
    )
    expect(screen.getByText('35,000 ft · 360 nm')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '100 nm' }))
    expect(screen.getByRole('button', { name: '100 nm' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText(/^[0-9,]+ ft · 100 nm$/)).toBeInTheDocument()
    expect(screen.queryByText('35,000 ft · 100 nm')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Whole route' }))
    expect(screen.getByText('35,000 ft · 360 nm')).toBeInTheDocument()
  })

  it('offers no zoom while there is no aircraft to centre on', () => {
    render(<RouteProfile waypoints={ROUTE} aircraft={null} altitudeUnit="ft" />)
    expect(screen.queryByRole('button', { name: '100 nm' })).not.toBeInTheDocument()
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

describe('RouteProfile step climbs', () => {
  const STEPPED = [
    wp('EGLL', 0, 83),
    wp('TOC', 1, 34000),
    wp('MID', 3, 34000),
    wp('STEP', 4, 36000),
    wp('END', 6, 36000),
    wp('KJFK', 8, 13)
  ]

  it('marks where each planned step climb starts with an up arrow, naming the level it climbs to', () => {
    render(<RouteProfile waypoints={STEPPED} aircraft={null} altitudeUnit="ft" />)
    expect(screen.getAllByTestId('route-profile-step')).toHaveLength(1)
    expect(screen.getByRole('img', { name: /^Step climb to 36,000.ft$/ })).toBeInTheDocument()
  })

  it('draws no arrow for a route without a step climb', () => {
    render(<RouteProfile waypoints={ROUTE} aircraft={null} altitudeUnit="ft" />)
    expect(screen.queryByTestId('route-profile-step')).not.toBeInTheDocument()
  })

  it('keeps the zoom buttons low, no taller than the words beside them', () => {
    render(
      <RouteProfile waypoints={STEPPED} aircraft={{ lon: 1, lat: 0, altitudeFt: 9000 }} altitudeUnit="ft" />
    )
    expect(screen.getByRole('button', { name: '100 nm' })).toHaveClass('h-6')
  })
})
