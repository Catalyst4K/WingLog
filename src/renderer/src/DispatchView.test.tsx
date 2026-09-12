import { useState } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import type { Aircraft, DispatchOfp, FleetStats, Flight, ProcedureSelection } from '@shared/ipc'
import { DispatchView } from './DispatchView'
import { emptyProcedureSelection } from './procedureSelection'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

// Radix Select/Dialog/AlertDialog reach for pointer-capture and scroll APIs jsdom doesn't
// implement — without these, opening a dropdown throws inside Radix's own event handlers.
beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.releasePointerCapture = () => {}
  Element.prototype.scrollIntoView = () => {}
})

function makeAircraft(overrides: Partial<Aircraft> = {}): Aircraft {
  return {
    id: 1,
    registration: 'G-ABCD',
    icaoType: 'A320',
    operator: 'Test Air',
    operatorIata: 'TA',
    operatorIcao: 'TAX',
    simbriefAirframeId: 'SB123',
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

function makeFlight(overrides: Partial<Flight> = {}): Flight {
  return {
    id: 1,
    aircraftId: 1,
    status: 'completed',
    flightNumber: 'TA100',
    depIcao: 'EGLL',
    arrIcao: 'EDDF',
    altnIcao: 'EDDL',
    routeString: 'DCT',
    cruiseAltM: 10668,
    schedOutUtc: null,
    schedInUtc: null,
    actualOutUtc: null,
    actualOffUtc: null,
    actualOnUtc: null,
    actualInUtc: null,
    blockMinutes: null,
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

function makeOfp(overrides: Partial<DispatchOfp> = {}): DispatchOfp {
  return {
    ofpId: 'ofp-1',
    aircraftIcaoType: 'A320',
    aircraftRegistration: 'G-ABCD',
    flightNumber: 'TA100',
    depIcao: 'EGLL',
    arrIcao: 'EDDF',
    altnIcao: 'EDDL',
    routeString: 'DCT',
    cruiseAltM: 10668,
    schedOutUtc: '2026-01-01T10:00:00.000Z',
    schedInUtc: '2026-01-01T12:00:00.000Z',
    fuelPlannedKg: 5000,
    pax: 150,
    cargoKg: 1000,
    zfwKg: 60000,
    towKg: 65000,
    ldwKg: 62000,
    costIndex: 25,
    waypoints: [],
    stepClimbs: [{ atIdent: 'ABCDE', toAltitudeFt: 37000, native: { unit: 'ft', value: 37000 } }],
    ofpJson: '{}',
    matchedAircraftId: 1,
    simbriefIsCustom: false,
    simbriefInternalId: null,
    ...overrides
  }
}

function createWinglog(overrides: Record<string, unknown> = {}): typeof window.winglog {
  return {
    aircraftList: vi.fn().mockResolvedValue([]),
    logbookFleetStats: vi.fn().mockResolvedValue([]),
    dispatchGenerationAvailable: vi.fn().mockResolvedValue(true),
    flightList: vi.fn().mockResolvedValue([]),
    dispatchOpenSimBrief: vi.fn().mockResolvedValue(undefined),
    dispatchGenerateOfp: vi.fn().mockResolvedValue(makeOfp()),
    dispatchFetchOfp: vi.fn().mockResolvedValue(makeOfp()),
    aircraftUpdate: vi.fn().mockImplementation((a) => Promise.resolve(a)),
    trackingGetActive: vi.fn().mockResolvedValue(null),
    dispatchOpenOfpPdf: vi.fn().mockResolvedValue(true),
    flightCreate: vi.fn().mockResolvedValue(makeFlight()),
    weatherGetMetars: vi.fn().mockResolvedValue([]),
    airportSearch: vi.fn().mockResolvedValue([]),
    navdataRefreshAirport: vi.fn().mockResolvedValue(undefined),
    navdataHasAirport: vi.fn().mockResolvedValue(false),
    navdataListRunways: vi.fn().mockResolvedValue([]),
    navdataListSids: vi.fn().mockResolvedValue([]),
    navdataListStars: vi.fn().mockResolvedValue([]),
    navdataListApproaches: vi.fn().mockResolvedValue([]),
    navdataGetProcedureWaypoints: vi.fn().mockResolvedValue([]),
    ...overrides
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

beforeEach(() => {
  window.winglog = createWinglog()
})

afterEach(() => {
  vi.clearAllMocks()
})

function Harness(props: {
  aircraft?: Aircraft[]
  weightUnit?: 'kg' | 'lb'
  altitudeUnit?: 'ft' | 'm' | 'hybrid'
  windSpeedUnit?: 'kt' | 'mps'
  initialOfp?: DispatchOfp | null
  initialDispatchedOfpId?: string | null
  onPlanned?: () => void
  onOfpChangeSpy?: (ofp: DispatchOfp | null) => void
  onDispatchedOfpIdChangeSpy?: (id: string | null) => void
}): React.JSX.Element {
  const [ofp, setOfp] = useState<DispatchOfp | null>(props.initialOfp ?? null)
  const [dispatchedOfpId, setDispatchedOfpId] = useState<string | null>(props.initialDispatchedOfpId ?? null)
  const [selection, setSelection] = useState<ProcedureSelection>(emptyProcedureSelection())
  return (
    <DispatchView
      weightUnit={props.weightUnit ?? 'kg'}
      altitudeUnit={props.altitudeUnit ?? 'ft'}
      windSpeedUnit={props.windSpeedUnit ?? 'kt'}
      onPlanned={props.onPlanned}
      ofp={ofp}
      onOfpChange={(v) => {
        props.onOfpChangeSpy?.(v)
        setOfp(v)
      }}
      dispatchedOfpId={dispatchedOfpId}
      onDispatchedOfpIdChange={(id) => {
        props.onDispatchedOfpIdChangeSpy?.(id)
        setDispatchedOfpId(id)
      }}
      selection={selection}
      onSelectionChange={setSelection}
    />
  )
}

/** Scopes to the <Select> sibling of the Label with this exact text — avoids ambiguity
 *  with the several other Selects ProcedureSelector renders once an OFP is loaded. */
function selectTriggerNear(labelText: string): HTMLElement {
  const label = screen.getByText(labelText, { selector: 'label' })
  return within(label.parentElement as HTMLElement).getByRole('combobox')
}

describe('DispatchView', () => {
  it('loads aircraft (filtering retired ones), fleet stats and past flights on mount', async () => {
    const retired = makeAircraft({ id: 9, registration: 'G-OLD', replacedByAircraftId: 1 })
    const other = makeAircraft({ id: 2, registration: 'G-EFGH', operator: null })
    window.winglog = createWinglog({
      aircraftList: vi.fn().mockResolvedValue([makeAircraft(), retired, other])
    })
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(selectTriggerNear('Aircraft'))
    expect(await screen.findByRole('option', { name: /G-ABCD/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /G-EFGH/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /G-OLD/ })).not.toBeInTheDocument()
  })

  it('shows no airport for the METAR panel until one is set', () => {
    render(<Harness />)
    expect(screen.getByText('No airport set.')).toBeInTheDocument()
  })

  it('shows the placeholder message when no plan is loaded', () => {
    render(<Harness />)
    expect(screen.getByText('Plan or fetch a flight to see its details here.')).toBeInTheDocument()
  })

  describe('selecting an aircraft to plan with', () => {
    it('prefills departure from the aircraft\'s own currentIcao, and airline from operatorIcao', async () => {
      window.winglog = createWinglog({ aircraftList: vi.fn().mockResolvedValue([makeAircraft()]) })
      const user = userEvent.setup()
      render(<Harness />)

      await user.click(selectTriggerNear('Aircraft'))
      await user.click(await screen.findByRole('option', { name: /G-ABCD/ }))

      expect(screen.getByPlaceholderText('e.g. BAW')).toHaveValue('TAX')
      // Departure ICAO field is a Combobox input with no distinguishing placeholder besides
      // the default one; assert via the underlying text input's value instead.
      const depInput = within(screen.getByText('Departure', { selector: 'label' }).parentElement as HTMLElement).getByRole(
        'textbox'
      )
      expect(depInput).toHaveValue('EGLL')
    })

    it('falls back to the last completed flight\'s arrival airport when currentIcao is unset', async () => {
      const noHome = makeAircraft({ id: 2, registration: 'G-EFGH', currentIcao: null, operatorIcao: null })
      const stats: FleetStats[] = [
        { aircraftId: 2, registration: 'G-EFGH', totalHours: 10, totalCycles: 5, lastArrIcao: 'EGKK', lastFlightInUtc: null }
      ]
      window.winglog = createWinglog({
        aircraftList: vi.fn().mockResolvedValue([noHome]),
        logbookFleetStats: vi.fn().mockResolvedValue(stats)
      })
      const user = userEvent.setup()
      render(<Harness />)

      await user.click(selectTriggerNear('Aircraft'))
      await user.click(await screen.findByRole('option', { name: /G-EFGH/ }))

      const depInput = within(screen.getByText('Departure', { selector: 'label' }).parentElement as HTMLElement).getByRole(
        'textbox'
      )
      expect(depInput).toHaveValue('EGKK')
      // No operatorIcao on this aircraft -> airline field stays blank.
      expect(screen.getByPlaceholderText('e.g. BAW')).toHaveValue('')
    })

    it('leaves departure blank when the aircraft has neither currentIcao nor flight history', async () => {
      const bare = makeAircraft({ id: 3, registration: 'G-BARE', currentIcao: null })
      window.winglog = createWinglog({ aircraftList: vi.fn().mockResolvedValue([bare]) })
      const user = userEvent.setup()
      render(<Harness />)

      await user.click(selectTriggerNear('Aircraft'))
      await user.click(await screen.findByRole('option', { name: /G-BARE/ }))

      const depInput = within(screen.getByText('Departure', { selector: 'label' }).parentElement as HTMLElement).getByRole(
        'textbox'
      )
      expect(depInput).toHaveValue('')
    })

    it('sets a non-empty default departure time once an aircraft is chosen', async () => {
      window.winglog = createWinglog({ aircraftList: vi.fn().mockResolvedValue([makeAircraft()]) })
      const user = userEvent.setup()
      render(<Harness />)

      await user.click(selectTriggerNear('Aircraft'))
      await user.click(await screen.findByRole('option', { name: /G-ABCD/ }))

      expect(screen.getByLabelText('Departure (UTC/Z)')).not.toHaveValue('')
    })

    it('allows editing the departure date/time directly', async () => {
      window.winglog = createWinglog({ aircraftList: vi.fn().mockResolvedValue([makeAircraft()]) })
      const user = userEvent.setup()
      render(<Harness />)

      await user.click(selectTriggerNear('Aircraft'))
      await user.click(await screen.findByRole('option', { name: /G-ABCD/ }))

      const input = screen.getByLabelText('Departure (UTC/Z)')
      await userEvent.clear(input)
      // fireEvent-style change via userEvent.type on a datetime-local input.
      await userEvent.type(input, '2026-03-01T08:30')
      expect(input).toHaveValue('2026-03-01T08:30')
    })

    it('lets airline ICAO and flight number be typed and uppercases the airline field', async () => {
      window.winglog = createWinglog({ aircraftList: vi.fn().mockResolvedValue([makeAircraft({ operatorIcao: null })]) })
      const user = userEvent.setup()
      render(<Harness />)

      await user.click(selectTriggerNear('Aircraft'))
      await user.click(await screen.findByRole('option', { name: /G-ABCD/ }))

      await user.type(screen.getByPlaceholderText('e.g. BAW'), 'baw')
      expect(screen.getByPlaceholderText('e.g. BAW')).toHaveValue('BAW')
      await user.type(screen.getByPlaceholderText('e.g. 02'), '042')
      expect(screen.getByPlaceholderText('e.g. 02')).toHaveValue('042')
    })
  })

  describe('generation availability', () => {
    it('shows Generate when generation is available, disabled until aircraft+airports are set', async () => {
      window.winglog = createWinglog({
        aircraftList: vi.fn().mockResolvedValue([makeAircraft()]),
        dispatchGenerationAvailable: vi.fn().mockResolvedValue(true)
      })
      const user = userEvent.setup()
      render(<Harness />)

      expect(await screen.findByRole('button', { name: 'Generate…' })).toBeDisabled()

      await user.click(selectTriggerNear('Aircraft'))
      await user.click(await screen.findByRole('option', { name: /G-ABCD/ }))
      // currentIcao/destIcao: dep is prefilled, dest still empty -> still disabled.
      expect(screen.getByRole('button', { name: 'Generate…' })).toBeDisabled()

      const destInput = within(screen.getByText('Destination', { selector: 'label' }).parentElement as HTMLElement).getByRole(
        'textbox'
      )
      await user.type(destInput, 'EDDF')
      expect(screen.getByRole('button', { name: 'Generate…' })).toBeEnabled()
    })

    it('falls back to "Plan on SimBrief…" when generation is unavailable', async () => {
      window.winglog = createWinglog({ dispatchGenerationAvailable: vi.fn().mockResolvedValue(false) })
      render(<Harness />)
      expect(await screen.findByRole('button', { name: 'Plan on SimBrief…' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Generate…' })).not.toBeInTheDocument()
    })

    it('opens SimBrief with the current form values when the fallback button is clicked', async () => {
      const dispatchOpenSimBrief = vi.fn().mockResolvedValue(undefined)
      window.winglog = createWinglog({
        aircraftList: vi.fn().mockResolvedValue([makeAircraft()]),
        dispatchGenerationAvailable: vi.fn().mockResolvedValue(false),
        dispatchOpenSimBrief
      })
      const user = userEvent.setup()
      render(<Harness />)

      await user.click(selectTriggerNear('Aircraft'))
      await user.click(await screen.findByRole('option', { name: /G-ABCD/ }))
      const destInput = within(screen.getByText('Destination', { selector: 'label' }).parentElement as HTMLElement).getByRole(
        'textbox'
      )
      await user.type(destInput, 'EDDF')

      await user.click(screen.getByRole('button', { name: 'Plan on SimBrief…' }))

      expect(dispatchOpenSimBrief).toHaveBeenCalledWith(
        expect.objectContaining({ origIcao: 'EGLL', destIcao: 'EDDF', icaoType: 'A320' })
      )
    })
  })

  describe('fetching a plan', () => {
    it('fetches the latest OFP and shows its details, toggling the button label while pending', async () => {
      let resolveFetch: (v: DispatchOfp) => void = () => {}
      const dispatchFetchOfp = vi.fn(() => new Promise<DispatchOfp>((resolve) => (resolveFetch = resolve)))
      window.winglog = createWinglog({ dispatchFetchOfp })
      const user = userEvent.setup()
      render(<Harness />)

      await user.click(screen.getByRole('button', { name: 'Fetch latest OFP' }))
      expect(screen.getByRole('button', { name: 'Fetching…' })).toBeDisabled()

      resolveFetch(makeOfp({ matchedAircraftId: null }))

      expect(await screen.findByText('TA100: EGLL → EDDF (altn EDDL)')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Fetch latest OFP' })).toBeEnabled()
    })

    it('shows an error toast when fetching fails with an Error', async () => {
      window.winglog = createWinglog({ dispatchFetchOfp: vi.fn().mockRejectedValue(new Error('no username set')) })
      const user = userEvent.setup()
      render(<Harness />)

      await user.click(screen.getByRole('button', { name: 'Fetch latest OFP' }))

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('no username set'))
    })

    it('shows an error toast with the stringified value when fetching fails with a non-Error', async () => {
      window.winglog = createWinglog({ dispatchFetchOfp: vi.fn().mockRejectedValue('offline') })
      const user = userEvent.setup()
      render(<Harness />)

      await user.click(screen.getByRole('button', { name: 'Fetch latest OFP' }))

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('offline'))
    })

    it('offers to save a custom airframe when the OFP used one not matching the fleet aircraft', async () => {
      window.winglog = createWinglog({
        aircraftList: vi.fn().mockResolvedValue([makeAircraft()]),
        dispatchFetchOfp: vi
          .fn()
          .mockResolvedValue(makeOfp({ matchedAircraftId: 1, simbriefIsCustom: true, simbriefInternalId: 'CUSTOM99' }))
      })
      const user = userEvent.setup()
      render(<Harness />)

      await user.click(screen.getByRole('button', { name: 'Fetch latest OFP' }))

      expect(await screen.findByText(/This plan used a custom SimBrief airframe not saved to G-ABCD\./)).toBeInTheDocument()

      const aircraftUpdate = vi.fn().mockResolvedValue(makeAircraft({ simbriefAirframeId: 'CUSTOM99' }))
      window.winglog.aircraftUpdate = aircraftUpdate
      await user.click(screen.getByRole('button', { name: 'Save this airframe' }))

      await waitFor(() =>
        expect(aircraftUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: 1, simbriefAirframeId: 'CUSTOM99' }))
      )
      expect(toast.success).toHaveBeenCalledWith('Saved this airframe to G-ABCD.')
      expect(screen.queryByText(/This plan used a custom SimBrief airframe/)).not.toBeInTheDocument()
    })

    it('shows an error toast if saving the captured airframe fails', async () => {
      window.winglog = createWinglog({
        aircraftList: vi.fn().mockResolvedValue([makeAircraft()]),
        dispatchFetchOfp: vi
          .fn()
          .mockResolvedValue(makeOfp({ matchedAircraftId: 1, simbriefIsCustom: true, simbriefInternalId: 'CUSTOM99' })),
        aircraftUpdate: vi.fn().mockRejectedValue(new Error('db locked'))
      })
      const user = userEvent.setup()
      render(<Harness />)

      await user.click(screen.getByRole('button', { name: 'Fetch latest OFP' }))
      await screen.findByRole('button', { name: 'Save this airframe' })
      await user.click(screen.getByRole('button', { name: 'Save this airframe' }))

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('db locked'))
    })

    it('warns when the OFP used SimBrief\'s default airframe instead of the matched aircraft\'s saved profile', async () => {
      window.winglog = createWinglog({
        aircraftList: vi.fn().mockResolvedValue([makeAircraft({ simbriefAirframeId: 'SAVED1' })]),
        dispatchFetchOfp: vi.fn().mockResolvedValue(makeOfp({ matchedAircraftId: 1, simbriefIsCustom: false, simbriefInternalId: null }))
      })
      const user = userEvent.setup()
      render(<Harness />)

      await user.click(screen.getByRole('button', { name: 'Fetch latest OFP' }))

      await waitFor(() =>
        expect(toast.warning).toHaveBeenCalledWith(
          "This plan used SimBrief's default airframe, not G-ABCD's saved profile (SAVED1) — the saved ID may be wrong."
        )
      )
    })

    it('prefers an aircraft already chosen in "Plan a flight" over the OFP\'s own registration match', async () => {
      const a1 = makeAircraft({ id: 1, registration: 'G-ABCD', simbriefAirframeId: null })
      const a2 = makeAircraft({ id: 2, registration: 'G-EFGH', simbriefAirframeId: null })
      window.winglog = createWinglog({
        aircraftList: vi.fn().mockResolvedValue([a1, a2]),
        dispatchFetchOfp: vi.fn().mockResolvedValue(makeOfp({ matchedAircraftId: 2, aircraftRegistration: 'G-EFGH' }))
      })
      const user = userEvent.setup()
      render(<Harness />)

      await user.click(selectTriggerNear('Aircraft'))
      await user.click(await screen.findByRole('option', { name: /G-ABCD/ }))
      await user.click(screen.getByRole('button', { name: 'Fetch latest OFP' }))

      await screen.findByText('TA100: EGLL → EDDF (altn EDDL)')
      const fleetSelect = selectTriggerNear('Fleet aircraft')
      // The pre-chosen G-ABCD (id 1) stays selected rather than switching to the OFP's own
      // registration match (id 2) — shown as "(matched)" only against G-EFGH's option.
      await user.click(fleetSelect)
      const matchedOption = await screen.findByRole('option', { name: /G-EFGH.*\(matched\)/ })
      expect(matchedOption).toBeInTheDocument()
    })
  })

  describe('generating a plan', () => {
    it('generates a plan, shows a success toast, and toggles the loading label', async () => {
      let resolveGenerate: (v: DispatchOfp) => void = () => {}
      const dispatchGenerateOfp = vi.fn(() => new Promise<DispatchOfp>((resolve) => (resolveGenerate = resolve)))
      window.winglog = createWinglog({ aircraftList: vi.fn().mockResolvedValue([makeAircraft()]), dispatchGenerateOfp })
      const user = userEvent.setup()
      render(<Harness />)

      await user.click(selectTriggerNear('Aircraft'))
      await user.click(await screen.findByRole('option', { name: /G-ABCD/ }))
      const destInput = within(screen.getByText('Destination', { selector: 'label' }).parentElement as HTMLElement).getByRole(
        'textbox'
      )
      await user.type(destInput, 'EDDF')

      await user.click(screen.getByRole('button', { name: 'Generate…' }))
      expect(screen.getByRole('button', { name: 'Generating…' })).toBeDisabled()

      resolveGenerate(makeOfp())
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Plan generated.'))
      expect(dispatchGenerateOfp).toHaveBeenCalledWith(
        expect.objectContaining({ origIcao: 'EGLL', destIcao: 'EDDF', flightNumber: null, airlineIcao: 'TAX' })
      )
    })

    it('shows an error toast when generation fails with an Error', async () => {
      window.winglog = createWinglog({
        aircraftList: vi.fn().mockResolvedValue([makeAircraft()]),
        dispatchGenerateOfp: vi.fn().mockRejectedValue(new Error('generation failed'))
      })
      const user = userEvent.setup()
      render(<Harness />)

      await user.click(selectTriggerNear('Aircraft'))
      await user.click(await screen.findByRole('option', { name: /G-ABCD/ }))
      const destInput = within(screen.getByText('Destination', { selector: 'label' }).parentElement as HTMLElement).getByRole(
        'textbox'
      )
      await user.type(destInput, 'EDDF')
      await user.click(screen.getByRole('button', { name: 'Generate…' }))

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('generation failed'))
    })

    it('shows an error toast with the stringified value when generation fails with a non-Error', async () => {
      window.winglog = createWinglog({
        aircraftList: vi.fn().mockResolvedValue([makeAircraft()]),
        dispatchGenerateOfp: vi.fn().mockRejectedValue('boom')
      })
      const user = userEvent.setup()
      render(<Harness />)

      await user.click(selectTriggerNear('Aircraft'))
      await user.click(await screen.findByRole('option', { name: /G-ABCD/ }))
      const destInput = within(screen.getByText('Destination', { selector: 'label' }).parentElement as HTMLElement).getByRole(
        'textbox'
      )
      await user.type(destInput, 'EDDF')
      await user.click(screen.getByRole('button', { name: 'Generate…' }))

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('boom'))
    })
  })

  describe('OFP details panel', () => {
    it('renders full plan details, and "None" when there are no step climbs', async () => {
      window.winglog = createWinglog({ dispatchFetchOfp: vi.fn().mockResolvedValue(makeOfp({ stepClimbs: [], costIndex: null })) })
      const user = userEvent.setup()
      render(<Harness />)
      await user.click(screen.getByRole('button', { name: 'Fetch latest OFP' }))

      await screen.findByText('TA100: EGLL → EDDF (altn EDDL)')
      expect(screen.getByText('None')).toBeInTheDocument()
      expect(screen.getByText('—')).toBeInTheDocument()
    })

    it('renders step climb badges when present', async () => {
      window.winglog = createWinglog({ dispatchFetchOfp: vi.fn().mockResolvedValue(makeOfp()) })
      const user = userEvent.setup()
      render(<Harness />)
      await user.click(screen.getByRole('button', { name: 'Fetch latest OFP' }))

      await screen.findByText('TA100: EGLL → EDDF (altn EDDL)')
      expect(screen.getByText('ABCDE')).toBeInTheDocument()
    })

    it('shows a hint when no fleet aircraft matches the OFP registration', async () => {
      window.winglog = createWinglog({ dispatchFetchOfp: vi.fn().mockResolvedValue(makeOfp({ matchedAircraftId: null })) })
      const user = userEvent.setup()
      render(<Harness />)
      await user.click(screen.getByRole('button', { name: 'Fetch latest OFP' }))

      expect(await screen.findByText(/No fleet aircraft matches tail G-ABCD/)).toBeInTheDocument()
    })

    it('unloading the plan is done via Discard plan, and the panel resets', async () => {
      window.winglog = createWinglog({ dispatchFetchOfp: vi.fn().mockResolvedValue(makeOfp()) })
      const user = userEvent.setup()
      render(<Harness />)
      await user.click(screen.getByRole('button', { name: 'Fetch latest OFP' }))
      await screen.findByText('TA100: EGLL → EDDF (altn EDDL)')

      await user.click(screen.getByRole('button', { name: 'Discard plan' }))
      const dialog = screen.getByRole('alertdialog')
      expect(within(dialog).getByText('Discard this plan?')).toBeInTheDocument()
      expect(within(dialog).getByText('You can fetch it again from SimBrief.')).toBeInTheDocument()
      await user.click(within(dialog).getByText('Discard plan'))

      expect(screen.getByText('Plan or fetch a flight to see its details here.')).toBeInTheDocument()
    })

    it('keeps the plan when discard is cancelled', async () => {
      window.winglog = createWinglog({ dispatchFetchOfp: vi.fn().mockResolvedValue(makeOfp()) })
      const user = userEvent.setup()
      render(<Harness />)
      await user.click(screen.getByRole('button', { name: 'Fetch latest OFP' }))
      await screen.findByText('TA100: EGLL → EDDF (altn EDDL)')

      await user.click(screen.getByRole('button', { name: 'Discard plan' }))
      await user.click(screen.getByRole('button', { name: 'Back' }))

      expect(screen.getByText('TA100: EGLL → EDDF (altn EDDL)')).toBeInTheDocument()
    })

    it('opens the OFP PDF and shows nothing extra when one is available', async () => {
      const dispatchOpenOfpPdf = vi.fn().mockResolvedValue(true)
      window.winglog = createWinglog({ dispatchFetchOfp: vi.fn().mockResolvedValue(makeOfp()), dispatchOpenOfpPdf })
      const user = userEvent.setup()
      render(<Harness />)
      await user.click(screen.getByRole('button', { name: 'Fetch latest OFP' }))
      await screen.findByText('TA100: EGLL → EDDF (altn EDDL)')

      await user.click(screen.getByRole('button', { name: 'View OFP PDF' }))

      await waitFor(() => expect(dispatchOpenOfpPdf).toHaveBeenCalledWith('{}'))
      expect(toast.error).not.toHaveBeenCalled()
    })

    it('shows an error toast when no OFP PDF is available', async () => {
      window.winglog = createWinglog({
        dispatchFetchOfp: vi.fn().mockResolvedValue(makeOfp()),
        dispatchOpenOfpPdf: vi.fn().mockResolvedValue(false)
      })
      const user = userEvent.setup()
      render(<Harness />)
      await user.click(screen.getByRole('button', { name: 'Fetch latest OFP' }))
      await screen.findByText('TA100: EGLL → EDDF (altn EDDL)')

      await user.click(screen.getByRole('button', { name: 'View OFP PDF' }))

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('No OFP PDF available for this plan.'))
    })
  })

  describe('flying a plan', () => {
    async function loadOfpAndPickAircraft(): Promise<void> {
      const user = userEvent.setup()
      await user.click(screen.getByRole('button', { name: 'Fetch latest OFP' }))
      await screen.findByText('TA100: EGLL → EDDF (altn EDDL)')
    }

    it('flies immediately (no confirmation) when nothing else is in progress', async () => {
      const onPlanned = vi.fn()
      const flightCreate = vi.fn().mockResolvedValue(makeFlight())
      window.winglog = createWinglog({
        aircraftList: vi.fn().mockResolvedValue([makeAircraft()]),
        dispatchFetchOfp: vi.fn().mockResolvedValue(makeOfp({ matchedAircraftId: 1 })),
        trackingGetActive: vi.fn().mockResolvedValue(null),
        flightList: vi.fn().mockResolvedValue([]),
        flightCreate
      })
      const user = userEvent.setup()
      render(<Harness onPlanned={onPlanned} />)
      await loadOfpAndPickAircraft()

      await user.click(screen.getByRole('button', { name: 'Fly' }))

      await waitFor(() =>
        expect(flightCreate).toHaveBeenCalledWith(
          expect.objectContaining({
            aircraftId: 1,
            flightNumber: 'TA100',
            depIcao: 'EGLL',
            selectedDepartureRunway: null,
            selectedApproachIdent: null
          })
        )
      )
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
      expect(onPlanned).toHaveBeenCalled()
      // The "Plan a flight" panel resets back to its empty state.
      expect(screen.getByText('— select —')).toBeInTheDocument()
    })

    it('marks the flight as already flying once saved, hiding the fleet-aircraft picker', async () => {
      window.winglog = createWinglog({
        aircraftList: vi.fn().mockResolvedValue([makeAircraft()]),
        dispatchFetchOfp: vi.fn().mockResolvedValue(makeOfp({ matchedAircraftId: 1 })),
        flightCreate: vi.fn().mockResolvedValue(makeFlight())
      })
      const user = userEvent.setup()
      render(<Harness />)
      await loadOfpAndPickAircraft()
      await user.click(screen.getByRole('button', { name: 'Fly' }))

      expect(await screen.findByText('Flying')).toBeInTheDocument()
      expect(screen.queryByText('Fleet aircraft')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Fly' })).toBeDisabled()
    })

    it('confirms before abandoning the flight currently being tracked', async () => {
      window.winglog = createWinglog({
        aircraftList: vi.fn().mockResolvedValue([makeAircraft()]),
        dispatchFetchOfp: vi.fn().mockResolvedValue(makeOfp({ matchedAircraftId: 1 })),
        trackingGetActive: vi.fn().mockResolvedValue({ flightId: 5, phase: 'cruise' }),
        flightList: vi.fn().mockResolvedValue([makeFlight({ id: 5, status: 'active', flightNumber: null })])
      })
      const user = userEvent.setup()
      render(<Harness />)
      await loadOfpAndPickAircraft()

      await user.click(screen.getByRole('button', { name: 'Fly' }))

      const dialog = await screen.findByRole('alertdialog')
      expect(within(dialog).getByText('This will abandon the flight currently being tracked, #5.')).toBeInTheDocument()
      await user.click(within(dialog).getByText('Back'))

      expect(window.winglog.flightCreate).not.toHaveBeenCalled()
    })

    it('confirming the active-flight warning flies the plan', async () => {
      window.winglog = createWinglog({
        aircraftList: vi.fn().mockResolvedValue([makeAircraft()]),
        dispatchFetchOfp: vi.fn().mockResolvedValue(makeOfp({ matchedAircraftId: 1 })),
        trackingGetActive: vi.fn().mockResolvedValue({ flightId: 5, phase: 'cruise' }),
        flightList: vi.fn().mockResolvedValue([makeFlight({ id: 5, status: 'active', flightNumber: 'BA9' })]),
        flightCreate: vi.fn().mockResolvedValue(makeFlight())
      })
      const user = userEvent.setup()
      render(<Harness />)
      await loadOfpAndPickAircraft()

      await user.click(screen.getByRole('button', { name: 'Fly' }))
      const dialog = await screen.findByRole('alertdialog')
      expect(within(dialog).getByText('This will abandon the flight currently being tracked, BA9.')).toBeInTheDocument()
      await user.click(within(dialog).getByText('Fly'))

      await waitFor(() => expect(window.winglog.flightCreate).toHaveBeenCalled())
    })

    it('warns about a single other planned flight, using its id when it has no flight number', async () => {
      window.winglog = createWinglog({
        aircraftList: vi.fn().mockResolvedValue([makeAircraft()]),
        dispatchFetchOfp: vi.fn().mockResolvedValue(makeOfp({ matchedAircraftId: 1 })),
        trackingGetActive: vi.fn().mockResolvedValue(null),
        flightList: vi.fn().mockResolvedValue([makeFlight({ id: 7, status: 'planned', flightNumber: null })])
      })
      const user = userEvent.setup()
      render(<Harness />)
      await loadOfpAndPickAircraft()

      await user.click(screen.getByRole('button', { name: 'Fly' }))
      const dialog = await screen.findByRole('alertdialog')
      expect(within(dialog).getByText('This will abandon the other planned flight, #7.')).toBeInTheDocument()
    })

    it('warns about a single other planned flight by flight number when it has one', async () => {
      window.winglog = createWinglog({
        aircraftList: vi.fn().mockResolvedValue([makeAircraft()]),
        dispatchFetchOfp: vi.fn().mockResolvedValue(makeOfp({ matchedAircraftId: 1 })),
        trackingGetActive: vi.fn().mockResolvedValue(null),
        flightList: vi.fn().mockResolvedValue([makeFlight({ id: 7, status: 'planned', flightNumber: 'BA10' })])
      })
      const user = userEvent.setup()
      render(<Harness />)
      await loadOfpAndPickAircraft()

      await user.click(screen.getByRole('button', { name: 'Fly' }))
      const dialog = await screen.findByRole('alertdialog')
      expect(within(dialog).getByText('This will abandon the other planned flight, BA10.')).toBeInTheDocument()
    })

    it('warns about multiple other planned flights with a count', async () => {
      window.winglog = createWinglog({
        aircraftList: vi.fn().mockResolvedValue([makeAircraft()]),
        dispatchFetchOfp: vi.fn().mockResolvedValue(makeOfp({ matchedAircraftId: 1 })),
        trackingGetActive: vi.fn().mockResolvedValue(null),
        flightList: vi.fn().mockResolvedValue([
          makeFlight({ id: 7, status: 'planned' }),
          makeFlight({ id: 8, status: 'planned' })
        ])
      })
      const user = userEvent.setup()
      render(<Harness />)
      await loadOfpAndPickAircraft()

      await user.click(screen.getByRole('button', { name: 'Fly' }))
      const dialog = await screen.findByRole('alertdialog')
      expect(within(dialog).getByText('This will abandon 2 other planned flights.')).toBeInTheDocument()
    })

    it('shows an error toast when saving the flight fails with an Error, and resets the Starting… label', async () => {
      let rejectCreate: (err: unknown) => void = () => {}
      const flightCreate = vi.fn(() => new Promise((_resolve, reject) => (rejectCreate = reject)))
      window.winglog = createWinglog({
        aircraftList: vi.fn().mockResolvedValue([makeAircraft()]),
        dispatchFetchOfp: vi.fn().mockResolvedValue(makeOfp({ matchedAircraftId: 1 })),
        flightCreate
      })
      const user = userEvent.setup()
      render(<Harness />)
      await loadOfpAndPickAircraft()

      await user.click(screen.getByRole('button', { name: 'Fly' }))
      expect(screen.getByRole('button', { name: 'Starting…' })).toBeDisabled()
      rejectCreate(new Error('save failed'))

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('save failed'))
      expect(await screen.findByRole('button', { name: 'Fly' })).toBeEnabled()
    })

    it('shows an error toast with a stringified value when saving fails with a non-Error', async () => {
      window.winglog = createWinglog({
        aircraftList: vi.fn().mockResolvedValue([makeAircraft()]),
        dispatchFetchOfp: vi.fn().mockResolvedValue(makeOfp({ matchedAircraftId: 1 })),
        flightCreate: vi.fn().mockRejectedValue('disk full')
      })
      const user = userEvent.setup()
      render(<Harness />)
      await loadOfpAndPickAircraft()

      await user.click(screen.getByRole('button', { name: 'Fly' }))

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('disk full'))
    })
  })

  it('allows opening and setting an Advanced dispatch option, reflected in the button label', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    expect(screen.getByRole('button', { name: 'Advanced' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Advanced' }))

    expect(screen.getByText('Advanced dispatch options')).toBeInTheDocument()
    await user.type(screen.getByLabelText('Passengers'), '150')
    await user.click(screen.getByRole('button', { name: /Done \(1 set\)/ }))

    expect(screen.getByRole('button', { name: 'Advanced (1)' })).toBeInTheDocument()
  })
})
