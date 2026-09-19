import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Aircraft, FreeFlightPrefill, SimTelemetry, WingLogApi } from '@shared/ipc'
import { StartFreeFlightDialog } from './StartFreeFlightDialog'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

// jsdom has no real pointer-capture implementation, which Radix's Select throws on when a
// test actually opens the dropdown (rather than relying on its default selection) — same
// polyfill DispatchView.test.tsx/FleetView.test.tsx/SettingsView.test.tsx already needed.
beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.releasePointerCapture = () => {}
  Element.prototype.scrollIntoView = () => {}
})

afterEach(() => {
  vi.clearAllMocks()
})

const AIRCRAFT: Aircraft = {
  id: 1,
  registration: 'G-EUYY',
  icaoType: 'A320',
  operator: null,
  operatorIata: null,
  operatorIcao: null,
  simbriefAirframeId: null,
  simbriefType: null,
  simbriefAirframeDeveloper: null,
  simbriefAirframeEngines: null,
  simbriefAirframeRegistration: null,
  currentIcao: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  replacedByAircraftId: null,
  retiredAt: null,
  photoThumbnailUrl: null
}

const RETIRED_AIRCRAFT: Aircraft = { ...AIRCRAFT, id: 2, registration: 'G-OLD', replacedByAircraftId: 1 }

function makeTelemetry(overrides: Partial<SimTelemetry> = {}): SimTelemetry {
  return {
    latitude: 51.4775,
    longitude: -0.4614,
    altitudeM: 25,
    pressureAltitudeM: 25,
    altitudeAglM: 0,
    verticalSpeedMs: 0,
    indicatedAirspeedMs: 0,
    trueAirspeedMs: 0,
    machSpeed: 0,
    groundSpeedMs: 0,
    headingTrueDeg: 270,
    pitchDeg: 0,
    bankDeg: 0,
    onGround: true,
    gForce: 1,
    fuelTotalKg: 10000,
    totalWeightKg: 70000,
    windSpeedMs: 3,
    windDirectionDeg: 250,
    engineCombustion1: false,
    gearHandlePosition: 1,
    flapsHandleIndex: 0,
    parkingBrakeOn: true,
    atcId: 'G-EUYY',
    atcModel: 'A320',
    title: 'FenixA320 IAE SL',
    simRate: 1,
    slewActive: false,
    ...overrides
  }
}

function makePrefill(overrides: Partial<FreeFlightPrefill> = {}): FreeFlightPrefill {
  return {
    registration: 'G-EUYY',
    icaoType: 'A320',
    icaoTypeAmbiguous: false,
    suggestedDepIcao: 'EGLL',
    rememberedAircraftId: null,
    ...overrides
  }
}

function setWinglog(overrides: Partial<WingLogApi> = {}): WingLogApi {
  const api = {
    trackingGetFreeFlightPrefill: vi.fn().mockResolvedValue(makePrefill()),
    trackingStartFree: vi.fn().mockResolvedValue(1),
    aircraftCreate: vi.fn().mockResolvedValue({ ...AIRCRAFT, id: 99 }),
    aircraftTypeSearch: vi.fn().mockResolvedValue([]),
    airportSearch: vi.fn().mockResolvedValue([]),
    ...overrides
  } as WingLogApi
  window.winglog = api
  return api
}

function renderDialog(
  props: Partial<Parameters<typeof StartFreeFlightDialog>[0]> = {}
): ReturnType<typeof render> {
  return render(
    <StartFreeFlightDialog
      open={props.open ?? true}
      onOpenChange={props.onOpenChange ?? vi.fn()}
      telemetry={props.telemetry === undefined ? makeTelemetry() : props.telemetry}
      aircraft={props.aircraft ?? [AIRCRAFT]}
      onStarted={props.onStarted ?? vi.fn()}
    />
  )
}

describe('StartFreeFlightDialog', () => {
  it('does not auto-match on atcId any more — registration alone never selects a fleet aircraft', async () => {
    setWinglog({
      trackingGetFreeFlightPrefill: vi.fn().mockResolvedValue(makePrefill({ registration: 'G-EUYY' }))
    })
    renderDialog({ aircraft: [AIRCRAFT] })
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Aircraft' })).toHaveTextContent('None'))
    expect(screen.getByLabelText('Registration')).toHaveValue('G-EUYY')
  })

  it('resolves a title-memory match automatically, without offering to create a new aircraft', async () => {
    setWinglog({
      trackingGetFreeFlightPrefill: vi
        .fn()
        .mockResolvedValue(makePrefill({ registration: 'G-EUYY', rememberedAircraftId: AIRCRAFT.id }))
    })
    renderDialog({ aircraft: [AIRCRAFT] })
    await waitFor(() => expect(screen.getByText('G-EUYY — A320')).toBeInTheDocument())
    expect(screen.queryByLabelText('Registration')).not.toBeInTheDocument()
  })

  it('excludes a retired aircraft from the title-memory match, defaulting to "don\'t add to fleet"', async () => {
    setWinglog({
      trackingGetFreeFlightPrefill: vi
        .fn()
        .mockResolvedValue(makePrefill({ registration: 'G-OLD', rememberedAircraftId: RETIRED_AIRCRAFT.id }))
    })
    renderDialog({ aircraft: [RETIRED_AIRCRAFT] })
    await waitFor(() => expect(screen.getByLabelText('Registration')).toHaveValue('G-OLD'))
  })

  it('defaults to "don\'t add to fleet" with editable, prefilled registration/type when nothing matches', async () => {
    setWinglog({
      trackingGetFreeFlightPrefill: vi
        .fn()
        .mockResolvedValue(makePrefill({ registration: 'N12345', icaoType: 'C172' }))
    })
    renderDialog({ aircraft: [] })
    await waitFor(() => expect(screen.getByLabelText('Registration')).toHaveValue('N12345'))
    expect(screen.getByRole('combobox', { name: 'Aircraft' })).toHaveTextContent('None')
    expect(screen.queryByText(/to fleet$/)).toBeNull()
  })

  it('is compact: Aircraft defaults to None with no explanatory paragraphs, and the rows are two-up', async () => {
    setWinglog({
      trackingGetFreeFlightPrefill: vi.fn().mockResolvedValue(makePrefill({ registration: 'G-EUYY' }))
    })
    renderDialog({ aircraft: [AIRCRAFT] })

    const aircraftSelect = await screen.findByRole('combobox', { name: 'Aircraft' })
    expect(aircraftSelect).toHaveTextContent('None')
    // The long "don't add to fleet" wording and the registration explainer are gone.
    expect(screen.queryByText(/add to fleet/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/aircraft-configuration page/i)).not.toBeInTheDocument()
    // Aircraft + Callsign share a row, as do Type + Registration and Departure + Destination.
    const row = (el: HTMLElement): HTMLElement => el.closest('.grid') as HTMLElement
    expect(row(aircraftSelect)).toContainElement(screen.getByLabelText('Callsign'))
    expect(row(screen.getByLabelText('Registration'))).toContainElement(
      screen.getByPlaceholderText('e.g. C172 or Cessna')
    )
  })

  it('shows the raw sim title as the Airframe line, verbatim', async () => {
    setWinglog()
    renderDialog({ aircraft: [], telemetry: makeTelemetry({ title: 'A350-900 (Default Cabin)' }) })
    expect(await screen.findByText('A350-900 (Default Cabin)')).toBeInTheDocument()
  })

  it("shows a non-blocking registration-mismatch hint when a remembered aircraft's on-file registration disagrees with the sim", async () => {
    setWinglog({
      trackingGetFreeFlightPrefill: vi
        .fn()
        .mockResolvedValue(makePrefill({ registration: 'F-WWTD', rememberedAircraftId: AIRCRAFT.id }))
    })
    renderDialog({ aircraft: [AIRCRAFT] })
    expect(await screen.findByText(/Registration on file for this aircraft is G-EUYY/)).toBeInTheDocument()
    expect(screen.getByText(/the sim currently\s*reports F-WWTD/)).toBeInTheDocument()
  })

  it('never blocks submission on a registration mismatch — it is a hint, not a validation error', async () => {
    const trackingStartFree = vi.fn().mockResolvedValue(1)
    setWinglog({
      trackingGetFreeFlightPrefill: vi
        .fn()
        .mockResolvedValue(makePrefill({ registration: 'F-WWTD', rememberedAircraftId: AIRCRAFT.id })),
      trackingStartFree
    })
    const user = userEvent.setup()
    renderDialog({ aircraft: [AIRCRAFT] })
    await screen.findByText(/Registration on file for this aircraft is G-EUYY/)
    await user.click(screen.getByText('Start tracking'))
    await waitFor(() =>
      expect(trackingStartFree).toHaveBeenCalledWith(expect.objectContaining({ aircraftId: AIRCRAFT.id }))
    )
  })

  it('shows a warning when the parsed type is ambiguous', async () => {
    setWinglog({
      trackingGetFreeFlightPrefill: vi.fn().mockResolvedValue(makePrefill({ icaoTypeAmbiguous: true }))
    })
    renderDialog({ aircraft: [] })
    expect(await screen.findByText(/this add-on has more than one variant/)).toBeInTheDocument()
  })

  it('shows "Not connected to the sim." and disables Start when there is no telemetry', async () => {
    setWinglog()
    renderDialog({ telemetry: null })
    expect(await screen.findByText('Not connected to the sim.')).toBeInTheDocument()
    expect(screen.getByText('Start tracking').closest('button')).toBeDisabled()
  })

  it('surfaces a prefill fetch failure as an error message', async () => {
    setWinglog({
      trackingGetFreeFlightPrefill: vi.fn().mockRejectedValue(new Error('sim disconnected mid-fetch'))
    })
    renderDialog()
    expect(await screen.findByText('sim disconnected mid-fetch')).toBeInTheDocument()
  })

  it('sends the edited callsign/departure/destination, not just the prefilled defaults, against a remembered aircraft', async () => {
    const trackingStartFree = vi.fn().mockResolvedValue(1)
    setWinglog({
      trackingGetFreeFlightPrefill: vi
        .fn()
        .mockResolvedValue(makePrefill({ rememberedAircraftId: AIRCRAFT.id })),
      trackingStartFree
    })
    const user = userEvent.setup()
    renderDialog({ aircraft: [AIRCRAFT] })

    await waitFor(() => expect(screen.getByText('G-EUYY — A320')).toBeInTheDocument())
    await user.type(screen.getByLabelText('Callsign'), 'VA123')
    await user.click(screen.getByText('Start tracking'))

    await waitFor(() =>
      expect(trackingStartFree).toHaveBeenCalledWith({
        aircraftId: AIRCRAFT.id,
        simRegistration: null,
        simIcaoType: null,
        depIcao: 'EGLL',
        arrIcao: null,
        flightNumber: 'VA123'
      })
    )
  })

  it('lets every prefilled field be edited by hand before submitting, tracked with no fleet aircraft', async () => {
    const trackingStartFree = vi.fn().mockResolvedValue(1)
    setWinglog({
      trackingGetFreeFlightPrefill: vi
        .fn()
        .mockResolvedValue(makePrefill({ registration: 'N999', icaoType: 'C172' })),
      trackingStartFree
    })
    const user = userEvent.setup()
    renderDialog({ aircraft: [] })

    await waitFor(() => expect(screen.getByLabelText('Registration')).toHaveValue('N999'))

    await user.clear(screen.getByLabelText('Registration'))
    await user.type(screen.getByLabelText('Registration'), 'N1234')
    expect(screen.getByLabelText('Registration')).toHaveValue('N1234')

    const [depInput, arrInput] = screen.getAllByPlaceholderText(/ICAO or search by name|Filled in on landing/)
    await user.clear(depInput)
    await user.type(depInput, 'EGCC')
    await user.type(arrInput, 'EGKK')

    await user.click(screen.getByText('Start tracking'))

    await waitFor(() =>
      expect(trackingStartFree).toHaveBeenCalledWith({
        aircraftId: null,
        simRegistration: 'N1234',
        simIcaoType: 'C172',
        depIcao: 'EGCC',
        arrIcao: 'EGKK',
        flightNumber: null
      })
    )
  })

  it('closes without submitting anything when Cancel is clicked', async () => {
    const trackingStartFree = vi.fn()
    const onOpenChange = vi.fn()
    setWinglog({
      trackingGetFreeFlightPrefill: vi
        .fn()
        .mockResolvedValue(makePrefill({ rememberedAircraftId: AIRCRAFT.id })),
      trackingStartFree
    })
    const user = userEvent.setup()
    renderDialog({ aircraft: [AIRCRAFT], onOpenChange })

    await waitFor(() => expect(screen.getByText('G-EUYY — A320')).toBeInTheDocument())
    await user.click(screen.getByText('Cancel'))

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(trackingStartFree).not.toHaveBeenCalled()
  })

  it('lets a hand-typed type override clear the ambiguous-type warning and flow through to trackingStartFree', async () => {
    const trackingStartFree = vi.fn().mockResolvedValue(1)
    setWinglog({
      trackingGetFreeFlightPrefill: vi
        .fn()
        .mockResolvedValue(makePrefill({ registration: 'N999', icaoType: 'A320', icaoTypeAmbiguous: true })),
      trackingStartFree
    })
    const user = userEvent.setup()
    renderDialog({ aircraft: [] })

    await screen.findByText(/this add-on has more than one variant/)
    const typeInput = screen.getByPlaceholderText('e.g. C172 or Cessna')
    await user.clear(typeInput)
    await user.type(typeInput, 'A20N')
    expect(screen.queryByText(/this add-on has more than one variant/)).not.toBeInTheDocument()

    await user.click(screen.getByText('Start tracking'))
    await waitFor(() =>
      expect(trackingStartFree).toHaveBeenCalledWith(expect.objectContaining({ simIcaoType: 'A20N' }))
    )
  })

  it('lets a free flight be tracked without adding to fleet — not mandatory (Callum, 2026-09-16)', async () => {
    const trackingStartFree = vi.fn().mockResolvedValue(9)
    const aircraftCreate = vi.fn()
    setWinglog({
      trackingGetFreeFlightPrefill: vi
        .fn()
        .mockResolvedValue(makePrefill({ registration: 'G-TEST', icaoType: 'C172' })),
      trackingStartFree,
      aircraftCreate
    })
    const user = userEvent.setup()
    renderDialog({ aircraft: [] })

    await waitFor(() => expect(screen.getByLabelText('Registration')).toHaveValue('G-TEST'))
    await user.click(screen.getByRole('combobox'))
    await user.click(await screen.findByRole('option', { name: 'None' }))
    // Still shown and editable — not added to a fleet doesn't mean not captured.
    expect(screen.getByLabelText('Registration')).toHaveValue('G-TEST')

    await user.click(screen.getByText('Start tracking'))

    await waitFor(() =>
      expect(trackingStartFree).toHaveBeenCalledWith({
        aircraftId: null,
        simRegistration: 'G-TEST',
        simIcaoType: 'C172',
        depIcao: 'EGLL',
        arrIcao: null,
        flightNumber: null
      })
    )
    expect(aircraftCreate).not.toHaveBeenCalled()
  })

  it('requires a registration and type when tracking without a fleet aircraft', async () => {
    const trackingStartFree = vi.fn()
    setWinglog({
      trackingGetFreeFlightPrefill: vi
        .fn()
        .mockResolvedValue(makePrefill({ registration: '', icaoType: null })),
      trackingStartFree
    })
    const user = userEvent.setup()
    renderDialog({ aircraft: [] })

    await waitFor(() => expect(screen.getByLabelText('Registration')).toHaveValue(''))
    await user.click(screen.getByRole('combobox'))
    await user.click(await screen.findByRole('option', { name: 'None' }))

    await user.click(screen.getByText('Start tracking'))

    expect(await screen.findByText('Enter a registration and type.')).toBeInTheDocument()
    expect(trackingStartFree).not.toHaveBeenCalled()
  })

  it('shows a toast and keeps the dialog open when trackingStartFree throws', async () => {
    const { toast } = await import('sonner')
    setWinglog({
      trackingGetFreeFlightPrefill: vi
        .fn()
        .mockResolvedValue(makePrefill({ rememberedAircraftId: AIRCRAFT.id })),
      trackingStartFree: vi.fn().mockRejectedValue(new Error('Not connected to the sim'))
    })
    const onOpenChange = vi.fn()
    const user = userEvent.setup()
    renderDialog({ aircraft: [AIRCRAFT], onOpenChange })

    await waitFor(() => expect(screen.getByText('G-EUYY — A320')).toBeInTheDocument())
    await user.click(screen.getByText('Start tracking'))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Not connected to the sim'))
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })
})
