import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { NavdataProcedureOption, NavdataRunwayOption, ProcedureSelection, WingLogApi } from '@shared/ipc'
import { ProcedureSelector } from './ProcedureSelector'
import { emptyProcedureSelection, type ProcedureAirports } from './procedureSelection'
import type { Waypoint } from './route'

function runway(ident: string): NavdataRunwayOption {
  return { ident, headingTrueDeg: 270, lengthM: 3800, widthM: 60, surface: 1, thresholdLat: 51.5, thresholdLon: -0.5 }
}

function proc(identifier: string, transition: string | null = null): NavdataProcedureOption {
  return { identifier, transition }
}

function airports(overrides: Partial<ProcedureAirports> = {}): ProcedureAirports {
  return { depIcao: 'EGLL', arrIcao: 'KJFK', ofpJson: null, ...overrides }
}

function waypoint(overrides: Partial<Waypoint> = {}): Waypoint {
  return { ident: 'FIXA', lon: 0, lat: 0, altitudeFt: 0, segment: 'enroute', ...overrides }
}

function withWinglog(overrides: Partial<WingLogApi> = {}): WingLogApi {
  const api = {
    navdataRefreshAirport: vi.fn().mockResolvedValue(undefined),
    navdataListRunways: vi.fn().mockResolvedValue([]),
    navdataListSids: vi.fn().mockResolvedValue([]),
    navdataListStars: vi.fn().mockResolvedValue([]),
    navdataListApproaches: vi.fn().mockResolvedValue([]),
    ...overrides
  } as unknown as WingLogApi
  window.winglog = api
  return api
}

function Harness(props: {
  airports: ProcedureAirports
  initialSelection?: ProcedureSelection
  liveWaypoints?: Waypoint[]
  onSelectionChange?: (next: ProcedureSelection) => void
}): React.JSX.Element {
  const [selection, setSelection] = useState<ProcedureSelection>(props.initialSelection ?? emptyProcedureSelection())
  return (
    <ProcedureSelector
      airports={props.airports}
      selection={selection}
      onSelectionChange={(next) => {
        setSelection(next)
        props.onSelectionChange?.(next)
      }}
      liveWaypoints={props.liveWaypoints ?? []}
    />
  )
}

/** Each ProcedureSelect renders `<Label>{label}</Label>` as a sibling (not a wrapper) of the
 *  Select, so there's no htmlFor/nesting association `getByLabelText` could use — locate the
 *  trigger by walking from the label text to their shared wrapper div instead. */
function selectFor(labelText: string): HTMLElement {
  const label = screen.getByText(labelText)
  const container = label.closest('div')!
  return within(container).getByRole('combobox')
}

describe('ProcedureSelector', () => {
  it('refreshes navdata for both airports on mount', async () => {
    const navdataRefreshAirport = vi.fn().mockResolvedValue(undefined)
    withWinglog({ navdataRefreshAirport })
    render(<Harness airports={airports()} />)

    await waitFor(() => expect(navdataRefreshAirport).toHaveBeenCalledWith('EGLL'))
    expect(navdataRefreshAirport).toHaveBeenCalledWith('KJFK')
  })

  it('re-refreshes only when the airport pair actually changes, not on every re-render', async () => {
    const navdataRefreshAirport = vi.fn().mockResolvedValue(undefined)
    withWinglog({ navdataRefreshAirport })
    const { rerender } = render(<Harness airports={airports({ ofpJson: null })} />)
    await waitFor(() => expect(navdataRefreshAirport).toHaveBeenCalledWith('EGLL'))
    const callsAfterMount = navdataRefreshAirport.mock.calls.length

    // A fresh `airports` object (as a real parent re-render would produce) with the exact
    // same depIcao/arrIcao must not trigger another refresh.
    rerender(<Harness airports={airports({ ofpJson: '{}' })} />)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(navdataRefreshAirport.mock.calls.length).toBe(callsAfterMount)

    rerender(<Harness airports={airports({ depIcao: 'EGKK', ofpJson: '{}' })} />)
    await waitFor(() => expect(navdataRefreshAirport).toHaveBeenCalledWith('EGKK'))
  })

  it('handles a failed navdata refresh without crashing (Promise.allSettled)', async () => {
    withWinglog({ navdataRefreshAirport: vi.fn().mockRejectedValue(new Error('sim not connected')) })
    render(<Harness airports={airports()} />)

    expect(await screen.findByText('Departure runway')).toBeInTheDocument()
  })

  it('lists departure runways once loaded, and disables the field when there are none', async () => {
    withWinglog({ navdataListRunways: vi.fn().mockResolvedValue([runway('27L'), runway('27R')]) })
    const user = userEvent.setup()
    render(<Harness airports={airports()} />)

    await waitFor(() => expect(selectFor('Departure runway')).not.toBeDisabled())
    await user.click(selectFor('Departure runway'))
    expect(await screen.findByRole('option', { name: '27L' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: '27R' })).toBeInTheDocument()
  })

  it('leaves the departure runway field disabled when the list is empty', async () => {
    withWinglog({ navdataListRunways: vi.fn().mockResolvedValue([]) })
    render(<Harness airports={airports()} />)

    await screen.findByText('Departure runway')
    expect(selectFor('Departure runway')).toBeDisabled()
  })

  it('picking a departure runway updates the selection and re-fetches SIDs for it', async () => {
    const navdataListSids = vi.fn().mockResolvedValue([proc('DET2G'), proc('DET2H')])
    withWinglog({ navdataListRunways: vi.fn().mockResolvedValue([runway('27L')]), navdataListSids })
    const user = userEvent.setup()
    let latest: ProcedureSelection | null = null
    render(<Harness airports={airports()} onSelectionChange={(s) => (latest = s)} />)

    await waitFor(() => expect(selectFor('Departure runway')).not.toBeDisabled())
    await user.click(selectFor('Departure runway'))
    await user.click(await screen.findByRole('option', { name: '27L' }))

    await waitFor(() => expect(latest?.departureRunway).toBe('27L'))
    await waitFor(() => expect(navdataListSids).toHaveBeenCalledWith('EGLL', '27L'))
  })

  it('lists SIDs, picking one sets sidIdent and clears any sidTransition', async () => {
    withWinglog({ navdataListSids: vi.fn().mockResolvedValue([proc('DET2G', 'DET'), proc('DET2G', 'LYD')]) })
    const user = userEvent.setup()
    let latest: ProcedureSelection | null = null
    render(
      <Harness
        airports={airports()}
        initialSelection={{ ...emptyProcedureSelection(), sidTransition: 'LYD' }}
        onSelectionChange={(s) => (latest = s)}
      />
    )

    await waitFor(() => expect(selectFor('SID')).not.toBeDisabled())
    await user.click(selectFor('SID'))
    await user.click(await screen.findByRole('option', { name: 'DET2G' }))

    expect(latest).toEqual(expect.objectContaining({ sidIdent: 'DET2G', sidTransition: null }))
  })

  it('lists SID transitions for the currently-selected SID only, and lets one be picked', async () => {
    withWinglog({
      navdataListSids: vi.fn().mockResolvedValue([proc('DET2G', 'DET'), proc('DET2G', 'LYD'), proc('OTHER', 'ABC')])
    })
    const user = userEvent.setup()
    let latest: ProcedureSelection | null = null
    render(
      <Harness
        airports={airports()}
        initialSelection={{ ...emptyProcedureSelection(), sidIdent: 'DET2G' }}
        onSelectionChange={(s) => (latest = s)}
      />
    )

    await waitFor(() => expect(selectFor('SID transition')).not.toBeDisabled())
    await user.click(selectFor('SID transition'))
    expect(await screen.findByRole('option', { name: 'DET' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'LYD' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'ABC' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('option', { name: 'DET' }))
    expect(latest).toEqual(expect.objectContaining({ sidTransition: 'DET' }))
  })

  it('falls back to an empty SID list when the fetch rejects', async () => {
    withWinglog({ navdataListSids: vi.fn().mockRejectedValue(new Error('no cache yet')) })
    render(<Harness airports={airports()} />)

    await screen.findByText('SID')
    await waitFor(() => expect(selectFor('SID')).toBeDisabled())
  })

  it('falls back to an empty STAR list when the fetch rejects', async () => {
    withWinglog({ navdataListStars: vi.fn().mockRejectedValue(new Error('no cache yet')) })
    render(<Harness airports={airports()} />)

    await screen.findByText('STAR')
    await waitFor(() => expect(selectFor('STAR')).toBeDisabled())
  })

  it('falls back to an empty approach list when the fetch rejects', async () => {
    withWinglog({ navdataListApproaches: vi.fn().mockRejectedValue(new Error('no cache yet')) })
    render(<Harness airports={airports()} />)

    await screen.findByText('Approach')
    await waitFor(() => expect(selectFor('Approach')).toBeDisabled())
  })

  it('lists STARs, picking one sets starIdent and clears any starTransition', async () => {
    withWinglog({ navdataListStars: vi.fn().mockResolvedValue([proc('BIG1A', 'BIG')]) })
    const user = userEvent.setup()
    let latest: ProcedureSelection | null = null
    render(
      <Harness
        airports={airports()}
        initialSelection={{ ...emptyProcedureSelection(), starTransition: 'STALE' }}
        onSelectionChange={(s) => (latest = s)}
      />
    )

    await waitFor(() => expect(selectFor('STAR')).not.toBeDisabled())
    await user.click(selectFor('STAR'))
    await user.click(await screen.findByRole('option', { name: 'BIG1A' }))

    expect(latest).toEqual(expect.objectContaining({ starIdent: 'BIG1A', starTransition: null }))
  })

  it('lists STAR transitions for the currently-selected STAR only', async () => {
    withWinglog({ navdataListStars: vi.fn().mockResolvedValue([proc('BIG1A', 'BIG'), proc('BIG1A', 'LAM'), proc('OTHER', 'X')]) })
    const user = userEvent.setup()
    let latest: ProcedureSelection | null = null
    render(
      <Harness
        airports={airports()}
        initialSelection={{ ...emptyProcedureSelection(), starIdent: 'BIG1A' }}
        onSelectionChange={(s) => (latest = s)}
      />
    )

    await waitFor(() => expect(selectFor('STAR transition')).not.toBeDisabled())
    await user.click(selectFor('STAR transition'))
    await user.click(await screen.findByRole('option', { name: 'LAM' }))

    expect(latest).toEqual(expect.objectContaining({ starTransition: 'LAM' }))
  })

  it('re-fetches STARs filtered by the current approach\'s runway once an approach is chosen', async () => {
    const navdataListStars = vi.fn().mockResolvedValue([])
    withWinglog({ navdataListStars })
    render(<Harness airports={airports()} initialSelection={{ ...emptyProcedureSelection(), approachIdent: 'ILS 07R' }} />)

    await waitFor(() => expect(navdataListStars).toHaveBeenCalledWith('KJFK', '07R'))
  })

  it('lists approaches, picking one sets approachIdent and clears any approachTransition', async () => {
    // Starts from an already-chosen approach (rather than null) so the auto-default effect
    // (see the dedicated tests below) has nothing to do here — this test is only about the
    // manual-pick path resetting approachTransition.
    withWinglog({ navdataListApproaches: vi.fn().mockResolvedValue([proc('ILS 07R'), proc('LOC 07R')]) })
    const user = userEvent.setup()
    let latest: ProcedureSelection | null = null
    render(
      <Harness
        airports={airports()}
        initialSelection={{ ...emptyProcedureSelection(), approachIdent: 'ILS 07R', approachTransition: 'STALE' }}
        onSelectionChange={(s) => (latest = s)}
      />
    )

    await waitFor(() => expect(selectFor('Approach')).not.toBeDisabled())
    await user.click(selectFor('Approach'))
    await user.click(await screen.findByRole('option', { name: 'LOC 07R' }))

    expect(latest).toEqual(expect.objectContaining({ approachIdent: 'LOC 07R', approachTransition: null }))
  })

  it('lists approach transitions for the currently-selected approach only', async () => {
    withWinglog({
      navdataListApproaches: vi.fn().mockResolvedValue([proc('ILS 07R', 'LIMES'), proc('ILS 07R', 'TD'), proc('LOC 07R', 'X')])
    })
    const user = userEvent.setup()
    let latest: ProcedureSelection | null = null
    render(
      <Harness
        airports={airports()}
        initialSelection={{ ...emptyProcedureSelection(), approachIdent: 'ILS 07R' }}
        onSelectionChange={(s) => (latest = s)}
      />
    )

    await waitFor(() => expect(selectFor('Approach transition')).not.toBeDisabled())
    await user.click(selectFor('Approach transition'))
    await user.click(await screen.findByRole('option', { name: 'TD' }))

    expect(latest).toEqual(expect.objectContaining({ approachTransition: 'TD' }))
  })

  it('auto-picks a default approach once options load, when nothing is chosen yet', async () => {
    withWinglog({ navdataListApproaches: vi.fn().mockResolvedValue([proc('RNAV Z 07R'), proc('ILS 07R'), proc('LOC 07R')]) })
    let latest: ProcedureSelection | null = null
    render(<Harness airports={airports()} onSelectionChange={(s) => (latest = s)} />)

    await waitFor(() => expect(latest?.approachIdent).toBe('ILS 07R'))
  })

  it('restricts the auto-picked approach to the OFP\'s planned arrival runway when one is set', async () => {
    const ofpJson = JSON.stringify({ api_params: { destrwy: '25L' }, general: {} })
    withWinglog({
      navdataListApproaches: vi.fn().mockResolvedValue([proc('ILS 07R'), proc('LOC 25L'), proc('RNAV Z 25L')])
    })
    let latest: ProcedureSelection | null = null
    render(<Harness airports={airports({ ofpJson })} onSelectionChange={(s) => (latest = s)} />)

    await waitFor(() => expect(latest?.approachIdent).toBe('LOC 25L'))
  })

  it('does not auto-pick an approach when one is already selected', async () => {
    const navdataListApproaches = vi.fn().mockResolvedValue([proc('ILS 07R'), proc('LOC 07R')])
    withWinglog({ navdataListApproaches })
    const onSelectionChange = vi.fn()
    render(
      <Harness
        airports={airports()}
        initialSelection={{ ...emptyProcedureSelection(), approachIdent: 'LOC 07R' }}
        onSelectionChange={onSelectionChange}
      />
    )

    await waitFor(() => expect(navdataListApproaches).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(onSelectionChange).not.toHaveBeenCalled()
  })

  it('auto-connects the approach transition to the STAR\'s last waypoint when it matches', async () => {
    withWinglog({ navdataListApproaches: vi.fn().mockResolvedValue([proc('ILS 07R', 'LIMES'), proc('ILS 07R', 'OTHER')]) })
    let latest: ProcedureSelection | null = null
    render(
      <Harness
        airports={airports()}
        initialSelection={{ ...emptyProcedureSelection(), approachIdent: 'ILS 07R' }}
        liveWaypoints={[waypoint({ ident: 'ENROUTE1' }), waypoint({ ident: 'LIMES', segment: 'star' })]}
        onSelectionChange={(s) => (latest = s)}
      />
    )

    await waitFor(() => expect(latest?.approachTransition).toBe('LIMES'))
  })

  it('does not auto-connect when the STAR\'s last waypoint is not one of the approach\'s transitions', async () => {
    withWinglog({ navdataListApproaches: vi.fn().mockResolvedValue([proc('ILS 07R', 'OTHERFIX')]) })
    const onSelectionChange = vi.fn()
    render(
      <Harness
        airports={airports()}
        initialSelection={{ ...emptyProcedureSelection(), approachIdent: 'ILS 07R' }}
        liveWaypoints={[waypoint({ ident: 'LIMES', segment: 'star' })]}
        onSelectionChange={onSelectionChange}
      />
    )

    await screen.findByText('Approach transition')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(onSelectionChange).not.toHaveBeenCalled()
  })

  it('does not auto-connect when there is no STAR segment in liveWaypoints at all', async () => {
    withWinglog({ navdataListApproaches: vi.fn().mockResolvedValue([proc('ILS 07R', 'LIMES')]) })
    const onSelectionChange = vi.fn()
    render(
      <Harness
        airports={airports()}
        initialSelection={{ ...emptyProcedureSelection(), approachIdent: 'ILS 07R' }}
        liveWaypoints={[waypoint({ ident: 'ENROUTE1', segment: 'enroute' })]}
        onSelectionChange={onSelectionChange}
      />
    )

    await screen.findByText('Approach transition')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(onSelectionChange).not.toHaveBeenCalled()
  })

  it('does not auto-connect an approach transition that is already set', async () => {
    withWinglog({ navdataListApproaches: vi.fn().mockResolvedValue([proc('ILS 07R', 'LIMES')]) })
    const onSelectionChange = vi.fn()
    render(
      <Harness
        airports={airports()}
        initialSelection={{ ...emptyProcedureSelection(), approachIdent: 'ILS 07R', approachTransition: 'MANUAL' }}
        liveWaypoints={[waypoint({ ident: 'LIMES', segment: 'star' })]}
        onSelectionChange={onSelectionChange}
      />
    )

    await screen.findByText('Approach transition')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(onSelectionChange).not.toHaveBeenCalled()
  })

  it('renders the Departure and Arrival section headings', () => {
    withWinglog()
    render(<Harness airports={airports()} />)
    expect(screen.getByText('Departure')).toBeInTheDocument()
    expect(screen.getByText('Arrival')).toBeInTheDocument()
  })
})
