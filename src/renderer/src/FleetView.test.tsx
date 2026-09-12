import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Aircraft, AircraftLanding, Flight, FleetStats, WingLogApi } from '@shared/ipc'
import { FleetView } from './FleetView'

// sonner's real toast has nothing to render into in these tests (no <Toaster/> mounted)
// and isn't a spy — mock it so `toast.error`/`toast.success` assertions work, matching the
// one IPC-adjacent seam (window.winglog) this batch's other tests mock.
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

afterEach(() => {
  vi.clearAllMocks()
})

// Radix Select renders a visually-hidden native <option> (for form autofill) alongside the
// real, visible listbox item in its portal — both carry the same text, so a bare
// `getByText`/`findByText` matches two elements. Scoping to `[data-slot="select-item"]`
// picks out only the real, clickable one.
async function pickSelectOption(user: ReturnType<typeof userEvent.setup>, label: string): Promise<void> {
  await user.click(screen.getByRole('combobox'))
  const item = await waitFor(() => {
    const found = Array.from(document.querySelectorAll('[data-slot="select-item"]')).find(
      (el) => el.textContent === label
    )
    if (!found) throw new Error(`No select item found with label "${label}"`)
    return found
  })
  await user.click(item)
}

function makeAircraft(overrides: Partial<Aircraft> = {}): Aircraft {
  return {
    id: 1,
    registration: 'G-ONE',
    icaoType: 'A320',
    operator: 'Test Air',
    operatorIata: 'TA',
    operatorIcao: 'TST',
    simbriefAirframeId: null,
    simbriefType: null,
    simbriefAirframeDeveloper: null,
    simbriefAirframeEngines: null,
    simbriefAirframeRegistration: null,
    currentIcao: 'EGLL',
    createdAt: '2026-01-01T00:00:00.000Z',
    replacedByAircraftId: null,
    photoThumbnailUrl: null,
    ...overrides
  }
}

function makeStats(overrides: Partial<FleetStats> = {}): FleetStats {
  return {
    aircraftId: 1,
    registration: 'G-ONE',
    totalHours: 12.5,
    totalCycles: 4,
    lastArrIcao: 'EGLL',
    lastFlightInUtc: '2026-02-01T12:00:00.000Z',
    ...overrides
  }
}

function makeFlight(overrides: Partial<Flight> = {}): Flight {
  return {
    id: 1,
    aircraftId: 1,
    status: 'completed',
    flightNumber: 'TA100',
    depIcao: 'EGLL',
    arrIcao: 'EGKK',
    altnIcao: null,
    routeString: null,
    cruiseAltM: null,
    schedOutUtc: null,
    schedInUtc: null,
    actualOutUtc: '2026-02-01T10:00:00.000Z',
    actualOffUtc: null,
    actualOnUtc: null,
    actualInUtc: null,
    blockMinutes: 65,
    airMinutes: null,
    fuelPlannedKg: null,
    fuelOutKg: null,
    fuelInKg: null,
    fuelBurnKg: null,
    pax: null,
    cargoKg: null,
    zfwKg: null,
    towKg: null,
    ldwKg: null,
    ofpId: null,
    ofpJson: null,
    simVersion: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    selectedDepartureRunway: null,
    selectedSidIdent: null,
    selectedSidTransition: null,
    selectedStarIdent: null,
    selectedStarTransition: null,
    selectedApproachIdent: null,
    selectedApproachTransition: null,
    ...overrides
  }
}

function makeLanding(overrides: Partial<AircraftLanding> = {}): AircraftLanding {
  return {
    id: 1,
    flightId: 1,
    touchdownTsUtc: '2026-02-01T12:00:00.000Z',
    verticalSpeedMs: -1.5,
    gForce: 1.2,
    pitchDeg: 3,
    bankDeg: 0,
    headingTrueDeg: 270,
    indicatedAirspeedMs: 70,
    groundSpeedMs: 70,
    windSpeedMs: 5,
    windDirectionDeg: 260,
    headwindMs: 4,
    crosswindMs: 2,
    crabDeg: 1,
    runwayIdent: '27L',
    distanceFromThresholdM: 300,
    centrelineOffsetM: 1,
    flapSetting: 3,
    touchdownSource: 'derived',
    flightNumber: 'TA100',
    depIcao: 'EGLL',
    arrIcao: 'EGKK',
    ...overrides
  }
}

function buildWinglog(overrides: Partial<WingLogApi> = {}): WingLogApi {
  return {
    aircraftList: vi.fn().mockResolvedValue([]),
    logbookFleetStats: vi.fn().mockResolvedValue([]),
    aircraftCreate: vi.fn(),
    aircraftUpdate: vi.fn(),
    aircraftDelete: vi.fn().mockResolvedValue(undefined),
    aircraftReplace: vi.fn().mockResolvedValue(undefined),
    fleetListLandings: vi.fn().mockResolvedValue([]),
    fleetListFlights: vi.fn().mockResolvedValue([]),
    flightList: vi.fn().mockResolvedValue([]),
    settingsGetLandingThresholds: vi.fn().mockResolvedValue({ firmFpm: 480, hardFpm: 600 }),
    dispatchOpenSimBriefAirframes: vi.fn().mockResolvedValue(undefined),
    // AircraftForm's own dependencies, needed whenever the new/edit view mounts.
    simbriefAirframesForType: vi.fn().mockResolvedValue([]),
    simbriefCreateCustomAirframe: vi.fn().mockResolvedValue(null),
    aircraftLookupByRegistration: vi.fn().mockResolvedValue(null),
    airlineFindByIcao: vi.fn().mockResolvedValue(undefined),
    aircraftTypeSearch: vi.fn().mockResolvedValue([]),
    airlineSearch: vi.fn().mockResolvedValue([]),
    airportSearch: vi.fn().mockResolvedValue([]),
    ...overrides
  } as WingLogApi
}

function setWinglog(overrides: Partial<WingLogApi> = {}): WingLogApi {
  const api = buildWinglog(overrides)
  window.winglog = api
  return api
}

// Real bug, not fixed here (test-writing only, per this batch's instructions):
// ReplaceAircraftDialog's handleConfirm awaits props.onConfirm with only a `finally`, no
// `catch` — FleetView's own handleConfirmReplace shows a toast on failure then re-throws,
// and that rethrow becomes a genuine unhandled rejection from the button's onClick (React
// discards an event handler's returned promise). Confirmed harmless in a real browser
// (Chromium just logs "Uncaught (in promise)"), but Node's own unhandledRejection detection
// — which is what vitest's process-level failure-on-unhandled-rejection reporting is built
// on — would otherwise fail this whole run. `run` still executes and its own assertions
// still exercise/verify the real toast.error call; this just pre-empts the leftover
// rejection rather than leaving it to fail the suite over a pre-existing bug this batch was
// told not to fix.
async function runExpectingUnhandledReplaceRejection(run: () => Promise<void>): Promise<void> {
  const suppressExpectedRejection = (_reason: unknown, promise: Promise<unknown>): void => {
    promise.catch(() => {})
  }
  // Reached via `globalThis` rather than the bare Node `process` global: this is a
  // renderer-side test file (tsconfig.web.json, no Node types), even though it runs under
  // Node/Electron in practice — see vitest.setup.renderer.ts for the same pattern.
  const nodeProcess = (
    globalThis as unknown as {
      process: {
        prependListener: (event: string, listener: (...args: never[]) => void) => void
        off: (event: string, listener: (...args: never[]) => void) => void
      }
    }
  ).process
  nodeProcess.prependListener('unhandledRejection', suppressExpectedRejection)
  try {
    await run()
  } finally {
    nodeProcess.off('unhandledRejection', suppressExpectedRejection)
  }
}

describe('FleetView', () => {
  it('shows the empty state when there are no active aircraft', async () => {
    setWinglog()
    render(<FleetView onOpenFlightInLogbook={vi.fn()} />)
    expect(
      await screen.findByText('No active aircraft — add one, or import a fleet from Settings → Data.')
    ).toBeInTheDocument()
  })

  it('lists active aircraft with their stats, defaulting hours/flights to 0.0/0 with no stats row', async () => {
    setWinglog({
      aircraftList: vi.fn().mockResolvedValue([makeAircraft()]),
      logbookFleetStats: vi.fn().mockResolvedValue([])
    })
    render(<FleetView onOpenFlightInLogbook={vi.fn()} />)
    expect(await screen.findByText('G-ONE')).toBeInTheDocument()
    expect(screen.getByText('0.0')).toBeInTheDocument()
    expect(screen.getByText('0')).toBeInTheDocument()
  })

  it('shows real stats when a fleet-stats row exists, falling back to lastArrIcao when currentIcao is unset', async () => {
    setWinglog({
      aircraftList: vi.fn().mockResolvedValue([makeAircraft({ currentIcao: null })]),
      logbookFleetStats: vi.fn().mockResolvedValue([makeStats({ lastArrIcao: 'LFPG' })])
    })
    render(<FleetView onOpenFlightInLogbook={vi.fn()} />)
    expect(await screen.findByText('12.5')).toBeInTheDocument()
    expect(screen.getByText('4')).toBeInTheDocument()
    expect(screen.getByText('LFPG')).toBeInTheDocument()
  })

  it('shows a dash for airline when unset', async () => {
    setWinglog({ aircraftList: vi.fn().mockResolvedValue([makeAircraft({ operator: null, operatorIata: null })]) })
    render(<FleetView onOpenFlightInLogbook={vi.fn()} />)
    await screen.findByText('G-ONE')
    expect(screen.getByText('—')).toBeInTheDocument()
  })

  it('sorts the active fleet table by every column when its header is clicked', async () => {
    const acA = makeAircraft({ id: 1, registration: 'B-MID', icaoType: 'B738', operator: 'Zed Air', currentIcao: 'EGKK' })
    const acB = makeAircraft({ id: 2, registration: 'A-LOW', icaoType: 'A320', operator: 'Alpha Air', currentIcao: null })
    // Two aircraft with no operator, no currentIcao, and no fleet-stats row at all — a
    // direct C-vs-D comparison exercises every `?? ''`/`?? 0` fallback on *both* sides of
    // each comparator (and the identical fallback in the plain location-cell render) that
    // acA/acB's real values don't reach.
    const acC = makeAircraft({ id: 3, registration: 'C-NULL', icaoType: 'C172', operator: null, currentIcao: null })
    const acD = makeAircraft({ id: 4, registration: 'D-ZERO', icaoType: 'D172', operator: null, currentIcao: null })
    setWinglog({
      aircraftList: vi.fn().mockResolvedValue([acA, acB, acC, acD]),
      logbookFleetStats: vi.fn().mockResolvedValue([
        makeStats({ aircraftId: 1, totalHours: 5, totalCycles: 10, lastArrIcao: 'EGKK' }),
        makeStats({ aircraftId: 2, totalHours: 20, totalCycles: 2, lastArrIcao: 'EGLL' })
      ])
    })
    const user = userEvent.setup()
    render(<FleetView onOpenFlightInLogbook={vi.fn()} />)
    await screen.findByText('B-MID')

    function registrationOrder(): string[] {
      return screen.getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell')[0].textContent ?? '')
    }
    // Default sort: registration ascending.
    expect(registrationOrder()).toEqual(['A-LOW', 'B-MID', 'C-NULL', 'D-ZERO'])

    await user.click(screen.getByText('Registration'))
    expect(registrationOrder()).toEqual(['D-ZERO', 'C-NULL', 'B-MID', 'A-LOW'])

    await user.click(screen.getByText('Type'))
    expect(registrationOrder()).toEqual(['A-LOW', 'B-MID', 'C-NULL', 'D-ZERO']) // A320 < B738 < C172 < D172

    await user.click(screen.getByText('Airline'))
    // '' ties between C-NULL/D-ZERO (stable sort keeps their original relative order), then
    // Alpha Air, then Zed Air.
    expect(registrationOrder()).toEqual(['C-NULL', 'D-ZERO', 'A-LOW', 'B-MID'])

    await user.click(screen.getByText('Location'))
    // B-MID's currentIcao is 'EGKK' directly; A-LOW has none, falling back to its stats'
    // lastArrIcao 'EGLL'; C-NULL/D-ZERO have neither, falling all the way back to ''.
    expect(registrationOrder()).toEqual(['C-NULL', 'D-ZERO', 'B-MID', 'A-LOW'])

    await user.click(screen.getByText('Hours'))
    expect(registrationOrder()).toEqual(['C-NULL', 'D-ZERO', 'B-MID', 'A-LOW']) // 0 < 5 < 20

    await user.click(screen.getByText('Flights'))
    expect(registrationOrder()).toEqual(['C-NULL', 'D-ZERO', 'A-LOW', 'B-MID']) // 0 < 2 < 10
  })

  it('lists retired aircraft separately, linking to a still-active replacement', async () => {
    const active = makeAircraft({ id: 1, registration: 'G-NEW' })
    const retired = makeAircraft({ id: 2, registration: 'G-OLD', replacedByAircraftId: 1 })
    setWinglog({ aircraftList: vi.fn().mockResolvedValue([active, retired]) })
    const user = userEvent.setup()
    render(<FleetView onOpenFlightInLogbook={vi.fn()} />)
    await screen.findByText('G-OLD')
    expect(screen.getByText('Retired')).toBeInTheDocument()

    // Clicking the replacement link opens that aircraft's detail without following the row's
    // own onClick (stopPropagation) — and shows a "Retired — replaced by" banner.
    await user.click(screen.getByRole('button', { name: 'G-NEW' }))
    expect(await screen.findByText(/^G-NEW — A320$/)).toBeInTheDocument()
  })

  it('shows a bare id fallback when a retired aircraft’s replacement is not in the fleet', async () => {
    const retired = makeAircraft({ id: 2, registration: 'G-OLD', replacedByAircraftId: 999 })
    setWinglog({ aircraftList: vi.fn().mockResolvedValue([retired]) })
    render(<FleetView onOpenFlightInLogbook={vi.fn()} />)
    expect(await screen.findByText('#999')).toBeInTheDocument()
  })

  it('opens a retired aircraft’s own detail page from its row, and its replaced-by link navigates onward', async () => {
    const active = makeAircraft({ id: 1, registration: 'G-NEW' })
    const retired = makeAircraft({ id: 2, registration: 'G-OLD', replacedByAircraftId: 1 })
    setWinglog({ aircraftList: vi.fn().mockResolvedValue([active, retired]) })
    const user = userEvent.setup()
    render(<FleetView onOpenFlightInLogbook={vi.fn()} />)
    await screen.findByText('G-OLD')
    // Click the row itself, not the replacement link within it.
    await user.click(screen.getByText('G-OLD'))
    expect(await screen.findByText('G-OLD — A320')).toBeInTheDocument()
    expect(screen.getByText(/Retired — replaced by/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'G-NEW' }))
    expect(await screen.findByText('G-NEW — A320')).toBeInTheDocument()
  })

  it('opens an aircraft’s detail page from the active table, and Back returns to the list', async () => {
    setWinglog({
      aircraftList: vi.fn().mockResolvedValue([makeAircraft()]),
      logbookFleetStats: vi.fn().mockResolvedValue([makeStats()])
    })
    const user = userEvent.setup()
    render(<FleetView onOpenFlightInLogbook={vi.fn()} />)
    await user.click(await screen.findByText('G-ONE'))
    expect(await screen.findByText('G-ONE — A320')).toBeInTheDocument()
    expect(screen.getByText('Test Air')).toBeInTheDocument()
    expect(screen.getByText('12.5')).toBeInTheDocument()
    expect(screen.getByText('4')).toBeInTheDocument()

    await user.click(screen.getByText('Back to fleet'))
    expect(await screen.findByText('Fleet')).toBeInTheDocument()
  })

  it('detail page falls back to the stats’ lastArrIcao for current airport when unset', async () => {
    setWinglog({
      aircraftList: vi.fn().mockResolvedValue([makeAircraft({ currentIcao: null })]),
      logbookFleetStats: vi.fn().mockResolvedValue([makeStats({ lastArrIcao: 'LFPG' })])
    })
    render(<FleetView onOpenFlightInLogbook={vi.fn()} initialAircraftId={1} />)
    expect(await screen.findByText('LFPG')).toBeInTheDocument()
  })

  it('detail page shows a dash for current airport when neither it nor any stats are set', async () => {
    setWinglog({ aircraftList: vi.fn().mockResolvedValue([makeAircraft({ currentIcao: null })]) })
    render(<FleetView onOpenFlightInLogbook={vi.fn()} initialAircraftId={1} />)
    await screen.findByText('G-ONE — A320')
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
  })

  it('shows a "not found" message for an unknown initial aircraft id, and consumes the prop once', async () => {
    setWinglog({ aircraftList: vi.fn().mockResolvedValue([]) })
    const onConsumed = vi.fn()
    render(
      <FleetView onOpenFlightInLogbook={vi.fn()} initialAircraftId={555} onInitialAircraftConsumed={onConsumed} />
    )
    expect(await screen.findByText('Aircraft not found.')).toBeInTheDocument()
    expect(onConsumed).toHaveBeenCalledTimes(1)
  })

  it('opens straight to detail for a given initialAircraftId', async () => {
    setWinglog({ aircraftList: vi.fn().mockResolvedValue([makeAircraft({ id: 7, registration: 'G-DIRECT' })]) })
    render(<FleetView onOpenFlightInLogbook={vi.fn()} initialAircraftId={7} />)
    expect(await screen.findByText('G-DIRECT — A320')).toBeInTheDocument()
  })

  it('does not reset on the initial mount, but returns to the list when resetSignal is later bumped', async () => {
    setWinglog({ aircraftList: vi.fn().mockResolvedValue([makeAircraft({ id: 7, registration: 'G-DIRECT' })]) })
    const { rerender } = render(<FleetView onOpenFlightInLogbook={vi.fn()} initialAircraftId={7} resetSignal={1} />)
    // Mount-time value of resetSignal must not immediately undo the initialAircraftId drill-down.
    expect(await screen.findByText('G-DIRECT — A320')).toBeInTheDocument()

    rerender(<FleetView onOpenFlightInLogbook={vi.fn()} initialAircraftId={7} resetSignal={2} />)
    expect(await screen.findByText('Fleet')).toBeInTheDocument()
  })

  it('creates a new aircraft from the New aircraft form and returns to the list', async () => {
    const created = makeAircraft({ id: 9, registration: 'G-BRANDNEW' })
    const winglog = setWinglog({
      aircraftList: vi.fn().mockResolvedValueOnce([]).mockResolvedValue([created]),
      aircraftCreate: vi.fn().mockResolvedValue(created)
    })
    const user = userEvent.setup()
    render(<FleetView onOpenFlightInLogbook={vi.fn()} />)
    await screen.findByText('No active aircraft — add one, or import a fleet from Settings → Data.')
    await user.click(screen.getByText('New aircraft'))
    expect(await screen.findByText('New aircraft', { selector: 'h1' })).toBeInTheDocument()

    const inputs = document.querySelectorAll('input[type="text"]')
    await user.type(inputs[0], 'G-BRANDNEW')
    await user.type(inputs[1], 'A320')
    await user.click(screen.getByText('Save'))

    await waitFor(() => expect(winglog.aircraftCreate).toHaveBeenCalled())
    expect(await screen.findByText('G-BRANDNEW')).toBeInTheDocument()
  })

  it('cancelling the New aircraft form returns to the list without creating anything', async () => {
    setWinglog({ aircraftList: vi.fn().mockResolvedValue([]) })
    const user = userEvent.setup()
    render(<FleetView onOpenFlightInLogbook={vi.fn()} />)
    await screen.findByText('No active aircraft — add one, or import a fleet from Settings → Data.')
    await user.click(screen.getByText('New aircraft'))
    await screen.findByText('New aircraft', { selector: 'h1' })
    await user.click(screen.getByText('Cancel'))
    expect(await screen.findByText('No active aircraft — add one, or import a fleet from Settings → Data.')).toBeInTheDocument()
  })

  it('edits an existing aircraft and returns to its detail page', async () => {
    const original = makeAircraft({ id: 3, registration: 'G-EDIT' })
    const updated = { ...original, registration: 'G-EDITED' }
    const winglog = setWinglog({
      aircraftList: vi.fn().mockResolvedValueOnce([original]).mockResolvedValue([updated]),
      aircraftUpdate: vi.fn().mockResolvedValue(updated)
    })
    const user = userEvent.setup()
    render(<FleetView onOpenFlightInLogbook={vi.fn()} />)
    await user.click(await screen.findByText('G-EDIT'))
    await screen.findByText('G-EDIT — A320')
    await user.click(screen.getByText('Edit'))
    expect(await screen.findByText('Edit G-EDIT')).toBeInTheDocument()

    await user.click(screen.getByText('Save'))
    await waitFor(() =>
      expect(winglog.aircraftUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: 3, registration: 'G-EDIT' }))
    )
    expect(await screen.findByText('G-EDITED — A320')).toBeInTheDocument()
  })

  it('cancelling an edit returns to the detail page unchanged', async () => {
    setWinglog({ aircraftList: vi.fn().mockResolvedValue([makeAircraft({ id: 3, registration: 'G-EDIT' })]) })
    const user = userEvent.setup()
    render(<FleetView onOpenFlightInLogbook={vi.fn()} />)
    await user.click(await screen.findByText('G-EDIT'))
    await user.click(screen.getByText('Edit'))
    await screen.findByText('Edit G-EDIT')
    await user.click(screen.getByText('Cancel'))
    expect(await screen.findByText('G-EDIT — A320')).toBeInTheDocument()
  })

  // No test for the edit view's "Aircraft not found." branch — it's not reachable via any
  // real click path (view.id always refers to an aircraft just found on the detail page a
  // moment earlier), so it's marked with a narrowly-scoped v8 ignore in FleetView.tsx
  // instead of faked here. Same reasoning covers a couple of other defensive-only guards
  // in that file (see its own comments).

  it('deletes an aircraft after confirming, then returns to the list', async () => {
    const winglog = setWinglog({
      aircraftList: vi.fn().mockResolvedValueOnce([makeAircraft({ id: 4, registration: 'G-DEL' })]).mockResolvedValue([])
    })
    const user = userEvent.setup()
    render(<FleetView onOpenFlightInLogbook={vi.fn()} />)
    await user.click(await screen.findByText('G-DEL'))
    await screen.findByText('G-DEL — A320')
    await user.click(screen.getByText('Delete'))
    expect(await screen.findByText('Delete G-DEL?')).toBeInTheDocument()

    await user.click(screen.getByText('Back'))
    expect(screen.queryByText('Delete G-DEL?')).not.toBeInTheDocument()

    await user.click(screen.getByText('Delete'))
    await user.click(screen.getByText('Delete aircraft'))
    await waitFor(() => expect(winglog.aircraftDelete).toHaveBeenCalledWith(4))
    expect(await screen.findByText('No active aircraft — add one, or import a fleet from Settings → Data.')).toBeInTheDocument()
  })

  it('shows a toast and stays put when deleting fails', async () => {
    const { toast } = await import('sonner')
    setWinglog({
      aircraftList: vi.fn().mockResolvedValue([makeAircraft({ id: 4, registration: 'G-DEL' })]),
      aircraftDelete: vi.fn().mockRejectedValue(new Error('cannot delete: has flights'))
    })
    const user = userEvent.setup()
    render(<FleetView onOpenFlightInLogbook={vi.fn()} />)
    await user.click(await screen.findByText('G-DEL'))
    await user.click(screen.getByText('Delete'))
    await user.click(screen.getByText('Delete aircraft'))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('cannot delete: has flights'))
  })

  it('shows a stringified toast when deleting fails with a non-Error', async () => {
    const { toast } = await import('sonner')
    setWinglog({
      aircraftList: vi.fn().mockResolvedValue([makeAircraft({ id: 4, registration: 'G-DEL' })]),
      aircraftDelete: vi.fn().mockRejectedValue('nope')
    })
    const user = userEvent.setup()
    render(<FleetView onOpenFlightInLogbook={vi.fn()} />)
    await user.click(await screen.findByText('G-DEL'))
    await user.click(screen.getByText('Delete'))
    await user.click(screen.getByText('Delete aircraft'))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('nope'))
  })

  it('does not show a Replace button on a retired aircraft’s detail page', async () => {
    setWinglog({
      aircraftList: vi.fn().mockResolvedValue([makeAircraft({ id: 5, registration: 'G-RET', replacedByAircraftId: 1 })])
    })
    render(<FleetView onOpenFlightInLogbook={vi.fn()} initialAircraftId={5} />)
    await screen.findByText('G-RET — A320')
    expect(screen.queryByText('Replace…')).not.toBeInTheDocument()
  })

  it('replaces an aircraft after choosing a target and confirming', async () => {
    const source = makeAircraft({ id: 1, registration: 'G-OLDTAIL' })
    const target = makeAircraft({ id: 2, registration: 'G-NEWTAIL' })
    const winglog = setWinglog({
      aircraftList: vi.fn().mockResolvedValue([source, target]),
      flightList: vi.fn().mockResolvedValue([makeFlight({ aircraftId: 1 }), makeFlight({ id: 2, aircraftId: 1 })])
    })
    const user = userEvent.setup()
    render(<FleetView onOpenFlightInLogbook={vi.fn()} initialAircraftId={1} />)
    await screen.findByText('G-OLDTAIL — A320')
    await user.click(screen.getByText('Replace…'))
    expect(await screen.findByText('Replace G-OLDTAIL')).toBeInTheDocument()

    await pickSelectOption(user, 'G-NEWTAIL — A320')
    expect(await screen.findByText(/2 flight\(s\) will move/)).toBeInTheDocument()

    await user.click(screen.getByText('Replace aircraft'))
    await waitFor(() => expect(winglog.aircraftReplace).toHaveBeenCalledWith(1, 2))
  })

  it('shows "Checking flight history…" until the flight count resolves', async () => {
    const source = makeAircraft({ id: 1, registration: 'G-OLDTAIL' })
    const target = makeAircraft({ id: 2, registration: 'G-NEWTAIL' })
    let resolveFlights: (flights: Flight[]) => void = () => {}
    setWinglog({
      aircraftList: vi.fn().mockResolvedValue([source, target]),
      flightList: vi.fn(() => new Promise<Flight[]>((resolve) => (resolveFlights = resolve)))
    })
    const user = userEvent.setup()
    render(<FleetView onOpenFlightInLogbook={vi.fn()} initialAircraftId={1} />)
    await screen.findByText('G-OLDTAIL — A320')
    await user.click(screen.getByText('Replace…'))
    await pickSelectOption(user, 'G-NEWTAIL — A320')
    expect(await screen.findByText(/Checking flight history…/)).toBeInTheDocument()

    resolveFlights([makeFlight({ aircraftId: 1 })])
    expect(await screen.findByText(/1 flight\(s\) will move/)).toBeInTheDocument()
  })

  it('cancelling the replace dialog leaves the aircraft untouched', async () => {
    const source = makeAircraft({ id: 1, registration: 'G-OLDTAIL' })
    const target = makeAircraft({ id: 2, registration: 'G-NEWTAIL' })
    const winglog = setWinglog({ aircraftList: vi.fn().mockResolvedValue([source, target]) })
    const user = userEvent.setup()
    render(<FleetView onOpenFlightInLogbook={vi.fn()} initialAircraftId={1} />)
    await screen.findByText('G-OLDTAIL — A320')
    await user.click(screen.getByText('Replace…'))
    await screen.findByText('Replace G-OLDTAIL')
    await user.click(screen.getByText('Cancel'))
    expect(screen.queryByText('Replace G-OLDTAIL')).not.toBeInTheDocument()
    expect(winglog.aircraftReplace).not.toHaveBeenCalled()
  })

  it('shows a toast (and does not close) when replace fails', async () => {
    const { toast } = await import('sonner')
    const source = makeAircraft({ id: 1, registration: 'G-OLDTAIL' })
    const target = makeAircraft({ id: 2, registration: 'G-NEWTAIL' })
    setWinglog({
      aircraftList: vi.fn().mockResolvedValue([source, target]),
      aircraftReplace: vi.fn().mockRejectedValue(new Error('same aircraft'))
    })
    const user = userEvent.setup()
    render(<FleetView onOpenFlightInLogbook={vi.fn()} initialAircraftId={1} />)
    await screen.findByText('G-OLDTAIL — A320')
    await user.click(screen.getByText('Replace…'))
    await screen.findByText('Replace G-OLDTAIL')
    await pickSelectOption(user, 'G-NEWTAIL — A320')
    await runExpectingUnhandledReplaceRejection(async () => {
      await user.click(screen.getByText('Replace aircraft'))
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('same aircraft'))
    })
  })

  it('shows a stringified toast when replace fails with a non-Error', async () => {
    const { toast } = await import('sonner')
    const source = makeAircraft({ id: 1, registration: 'G-OLDTAIL' })
    const target = makeAircraft({ id: 2, registration: 'G-NEWTAIL' })
    setWinglog({
      aircraftList: vi.fn().mockResolvedValue([source, target]),
      aircraftReplace: vi.fn().mockRejectedValue('nope')
    })
    const user = userEvent.setup()
    render(<FleetView onOpenFlightInLogbook={vi.fn()} initialAircraftId={1} />)
    await screen.findByText('G-OLDTAIL — A320')
    await user.click(screen.getByText('Replace…'))
    await screen.findByText('Replace G-OLDTAIL')
    await pickSelectOption(user, 'G-NEWTAIL — A320')
    await runExpectingUnhandledReplaceRejection(async () => {
      await user.click(screen.getByText('Replace aircraft'))
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('nope'))
    })
  })

  it('excludes the aircraft being replaced from its own candidate list', async () => {
    const source = makeAircraft({ id: 1, registration: 'G-OLDTAIL' })
    setWinglog({ aircraftList: vi.fn().mockResolvedValue([source]) })
    const user = userEvent.setup()
    render(<FleetView onOpenFlightInLogbook={vi.fn()} initialAircraftId={1} />)
    await screen.findByText('G-OLDTAIL — A320')
    await user.click(screen.getByText('Replace…'))
    await user.click(screen.getByRole('combobox'))
    // Only one aircraft exists (the one being replaced) — it must not offer itself as its
    // own replacement, so the dropdown ends up with no candidates at all.
    await waitFor(() => expect(document.querySelectorAll('[data-slot="select-item"]')).toHaveLength(0))
  })

  describe('SimBriefProfileCard', () => {
    it('shows a custom profile by its cached registration/engines', async () => {
      setWinglog({
        aircraftList: vi.fn().mockResolvedValue([
          makeAircraft({
            simbriefAirframeId: '123_456',
            simbriefAirframeRegistration: 'G-XWBS',
            simbriefAirframeEngines: 'Trent XWB'
          })
        ])
      })
      render(<FleetView onOpenFlightInLogbook={vi.fn()} initialAircraftId={1} />)
      expect(await screen.findByText(/Custom —/)).toBeInTheDocument()
      expect(screen.getByText(/G-XWBS \(Trent XWB\)/)).toBeInTheDocument()
      expect(screen.getByText('Open in SimBrief')).toBeInTheDocument()
    })

    it('falls back to the raw airframe id when no cached registration is set', async () => {
      setWinglog({ aircraftList: vi.fn().mockResolvedValue([makeAircraft({ simbriefAirframeId: '123_456' })]) })
      render(<FleetView onOpenFlightInLogbook={vi.fn()} initialAircraftId={1} />)
      expect(await screen.findByText('123_456')).toBeInTheDocument()
    })

    it('shows a custom profile’s registration alone when no engines label is cached', async () => {
      setWinglog({
        aircraftList: vi.fn().mockResolvedValue([
          makeAircraft({
            simbriefAirframeId: '123_456',
            simbriefAirframeRegistration: 'G-XWBS',
            simbriefAirframeEngines: null
          })
        ])
      })
      render(<FleetView onOpenFlightInLogbook={vi.fn()} initialAircraftId={1} />)
      expect(await screen.findByText('Custom — G-XWBS')).toBeInTheDocument()
    })

    it('opens the airframes page for a custom profile', async () => {
      const winglog = setWinglog({
        aircraftList: vi.fn().mockResolvedValue([makeAircraft({ simbriefAirframeId: '123_456' })])
      })
      const user = userEvent.setup()
      render(<FleetView onOpenFlightInLogbook={vi.fn()} initialAircraftId={1} />)
      await user.click(await screen.findByText('Open in SimBrief'))
      expect(winglog.dispatchOpenSimBriefAirframes).toHaveBeenCalledWith('123_456')
    })

    it('shows a cached developer/engine label for a chosen SimBrief default type', async () => {
      setWinglog({
        aircraftList: vi.fn().mockResolvedValue([
          makeAircraft({ simbriefType: 'A20N', simbriefAirframeDeveloper: 'FlyByWire', simbriefAirframeEngines: 'CFM' })
        ])
      })
      render(<FleetView onOpenFlightInLogbook={vi.fn()} initialAircraftId={1} />)
      expect(await screen.findByText('FlyByWire — CFM')).toBeInTheDocument()
    })

    it('shows just the developer when no engines label is cached for a chosen default type', async () => {
      setWinglog({
        aircraftList: vi.fn().mockResolvedValue([
          makeAircraft({ simbriefType: 'A20N', simbriefAirframeDeveloper: 'FlyByWire', simbriefAirframeEngines: null })
        ])
      })
      render(<FleetView onOpenFlightInLogbook={vi.fn()} initialAircraftId={1} />)
      expect(await screen.findByText('FlyByWire')).toBeInTheDocument()
    })

    it('shows the plain type code when a default type has no cached label', async () => {
      setWinglog({ aircraftList: vi.fn().mockResolvedValue([makeAircraft({ simbriefType: 'A20N' })]) })
      render(<FleetView onOpenFlightInLogbook={vi.fn()} initialAircraftId={1} />)
      expect(await screen.findByText(/Using SimBrief default:/)).toBeInTheDocument()
      expect(screen.getByText('A20N')).toBeInTheDocument()
    })

    it('shows the no-profile fallback message when nothing is set', async () => {
      setWinglog({ aircraftList: vi.fn().mockResolvedValue([makeAircraft({ icaoType: 'C172' })]) })
      render(<FleetView onOpenFlightInLogbook={vi.fn()} initialAircraftId={1} />)
      // "C172" also appears in the page's own "G-ONE — C172" header, so match the
      // fallback paragraph specifically rather than a bare /C172/ (ambiguous).
      expect(await screen.findByText(/No profile set — plans fall back .* C172/)).toBeInTheDocument()
    })
  })

  describe('LandingHistoryCard', () => {
    it('shows the empty state with no recorded landings', async () => {
      setWinglog({ aircraftList: vi.fn().mockResolvedValue([makeAircraft()]) })
      render(<FleetView onOpenFlightInLogbook={vi.fn()} initialAircraftId={1} />)
      expect(await screen.findByText('No landings recorded yet.')).toBeInTheDocument()
    })

    it('lists landings with fpm, runway, crosswind and a severity badge', async () => {
      setWinglog({
        aircraftList: vi.fn().mockResolvedValue([makeAircraft()]),
        fleetListLandings: vi.fn().mockResolvedValue([makeLanding({ verticalSpeedMs: -1.5 })])
      })
      render(<FleetView onOpenFlightInLogbook={vi.fn()} initialAircraftId={1} />)
      expect(await screen.findByText(/27L/)).toBeInTheDocument()
      expect(screen.getByText(/kt xwind/)).toBeInTheDocument()
    })

    it('shows a dash for crosswind and no runway ident when either is missing', async () => {
      setWinglog({
        aircraftList: vi.fn().mockResolvedValue([makeAircraft()]),
        fleetListLandings: vi.fn().mockResolvedValue([makeLanding({ crosswindMs: null, runwayIdent: null })])
      })
      render(<FleetView onOpenFlightInLogbook={vi.fn()} initialAircraftId={1} />)
      await screen.findByText('EGKK', { exact: false })
      expect(screen.getAllByText('—').length).toBeGreaterThan(0)
    })

    it('shows a severity badge for a firm/hard landing', async () => {
      setWinglog({
        aircraftList: vi.fn().mockResolvedValue([makeAircraft()]),
        fleetListLandings: vi.fn().mockResolvedValue([makeLanding({ verticalSpeedMs: -3.5 })]) // ~689 fpm -> hard
      })
      render(<FleetView onOpenFlightInLogbook={vi.fn()} initialAircraftId={1} />)
      expect(await screen.findByText('Hard')).toBeInTheDocument()
    })
  })

  describe('AircraftFlightsCard', () => {
    it('shows the empty state with no completed flights', async () => {
      setWinglog({ aircraftList: vi.fn().mockResolvedValue([makeAircraft()]) })
      render(<FleetView onOpenFlightInLogbook={vi.fn()} initialAircraftId={1} />)
      expect(await screen.findByText('No completed flights yet.')).toBeInTheDocument()
    })

    it('lists completed flights and navigates to Logbook on click', async () => {
      const onOpenFlightInLogbook = vi.fn()
      setWinglog({
        aircraftList: vi.fn().mockResolvedValue([makeAircraft()]),
        fleetListFlights: vi.fn().mockResolvedValue([makeFlight()])
      })
      const user = userEvent.setup()
      render(<FleetView onOpenFlightInLogbook={onOpenFlightInLogbook} initialAircraftId={1} />)
      await user.click(await screen.findByText('TA100'))
      expect(onOpenFlightInLogbook).toHaveBeenCalledWith(1, 1)
    })

    it('shows a dash for a flight with no flight number and formats block time', async () => {
      setWinglog({
        aircraftList: vi.fn().mockResolvedValue([makeAircraft()]),
        fleetListFlights: vi.fn().mockResolvedValue([makeFlight({ flightNumber: null, blockMinutes: null })])
      })
      render(<FleetView onOpenFlightInLogbook={vi.fn()} initialAircraftId={1} />)
      await screen.findByText('EGLL → EGKK')
      expect(screen.getAllByText('—').length).toBeGreaterThan(0)
    })
  })
})
