import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { NavdataStatus } from '@shared/ipc'
import { NavdataCard, NavdataCycleNote } from './NavdataCycle'
import { navdataWarning } from './navdata-status'

const CURRENT: NavdataStatus = {
  source: 'navigraph',
  cycle: '2611',
  revision: '1',
  validTo: '2026-11-25',
  calendarCycle: '2611',
  state: 'current'
}
const BEHIND: NavdataStatus = { ...CURRENT, cycle: '2610', validTo: '2026-10-28', state: 'behind' }
const DEFAULT: NavdataStatus = {
  source: 'default',
  cycle: null,
  revision: null,
  validTo: null,
  calendarCycle: '2611',
  state: 'default'
}

function serve(status: NavdataStatus | Promise<NavdataStatus>) {
  const api = {
    navdataGetStatus: vi.fn(() => Promise.resolve(status)),
    appLogRendererError: vi.fn(() => Promise.resolve())
  }
  window.winglog = api as unknown as typeof window.winglog
  return api
}

describe('navdataWarning', () => {
  it('is "behind" for a Navigraph cycle older than the calendar’s, whatever the plan says', () => {
    expect(navdataWarning(BEHIND)).toBe('behind')
    expect(navdataWarning(BEHIND, '2611')).toBe('behind')
  })

  it('is "planMismatch" when the plan was made with a different cycle from the sim’s', () => {
    expect(navdataWarning(CURRENT, '2610')).toBe('planMismatch')
    expect(navdataWarning({ ...CURRENT, cycle: '2612', calendarCycle: '2611' }, '2611')).toBe('planMismatch')
  })

  it.each([
    ['the plan was made with the sim’s cycle', CURRENT, '2611'],
    ['there is no plan', CURRENT, undefined],
    ['the plan does not say its cycle', CURRENT, null],
    ['the sim’s data is its own, which has no cycle to compare', DEFAULT, '2610']
  ])('is nothing when %s', (_label, status, plan) => {
    expect(navdataWarning(status, plan)).toBeNull()
  })
})

describe('NavdataCycleNote', () => {
  it('tells a pilot whose Navigraph data is behind to update it', async () => {
    serve(BEHIND)
    render(<NavdataCycleNote />)
    expect(await screen.findByRole('status')).toHaveTextContent(
      "Your sim's navigation data is Navigraph AIRAC 2610, but 2611 is the current cycle. Update it in the Navigraph Hub."
    )
  })

  it('tells a pilot when the plan and the sim are on different cycles', async () => {
    serve(CURRENT)
    render(<NavdataCycleNote planAirac="2610" />)
    expect(await screen.findByRole('status')).toHaveTextContent(
      'This plan was made with AIRAC 2610, but your sim has 2611.'
    )
  })

  it('says nothing for current data, a matching plan, or the sim’s own data', async () => {
    const api = serve(CURRENT)
    const { rerender } = render(<NavdataCycleNote planAirac="2611" />)
    await vi.waitFor(() => expect(api.navdataGetStatus).toHaveBeenCalled())
    expect(screen.queryByRole('status')).toBeNull()
    api.navdataGetStatus.mockResolvedValue(DEFAULT)
    rerender(<NavdataCycleNote key="again" planAirac="2610" />)
    await vi.waitFor(() => expect(api.navdataGetStatus).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('says nothing until main has answered, and does not set state after unmounting', async () => {
    let answer: (status: NavdataStatus) => void = () => {}
    const api = serve(new Promise<NavdataStatus>((resolve) => (answer = resolve)) as unknown as NavdataStatus)
    api.navdataGetStatus.mockImplementation(() => new Promise<NavdataStatus>((resolve) => (answer = resolve)))
    const { unmount } = render(<NavdataCycleNote />)
    expect(screen.queryByRole('status')).toBeNull()
    unmount()
    answer(BEHIND)
    await Promise.resolve()
    expect(screen.queryByRole('status')).toBeNull()
  })
})

describe('NavdataCard', () => {
  it('shows a Navigraph cycle, its revision and how long it is valid, and that it is current', async () => {
    serve(CURRENT)
    render(<NavdataCard />)
    expect(
      await screen.findByText('Navigraph AIRAC 2611, revision 1, valid until 2026-11-25')
    ).toBeInTheDocument()
    expect(screen.getByText('Up to date with the current cycle (2611).')).toBeInTheDocument()
  })

  it('shows a cycle with no end date without one, and warns when it is behind', async () => {
    serve({ ...BEHIND, validTo: null })
    render(<NavdataCard />)
    expect(await screen.findByText('Navigraph AIRAC 2610, revision 1')).toBeInTheDocument()
    expect(screen.getByText(/but 2611 is the current cycle/)).toBeInTheDocument()
  })

  it('says the sim’s own data states no cycle, and that the calendar is what WingLog goes by', async () => {
    serve(DEFAULT)
    render(<NavdataCard />)
    expect(
      await screen.findByText(/The sim's own data\. Its cycle cannot be read.*current cycle 2611/)
    ).toBeInTheDocument()
    expect(screen.queryByText(/Up to date/)).toBeNull()
  })

  it('shows only its title until main has answered', () => {
    serve(new Promise<NavdataStatus>(() => {}) as unknown as NavdataStatus)
    render(<NavdataCard />)
    expect(screen.getByText('Navigation data')).toBeInTheDocument()
  })
})
