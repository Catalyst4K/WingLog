import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Aircraft, Flight, WingLogApi } from '@shared/ipc'
import { AddFlightToFleetDialog } from './AddFlightToFleetDialog'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

// jsdom has no real pointer-capture implementation, which Radix's Select throws on when a
// test actually opens the dropdown — same polyfill StartFreeFlightDialog.test.tsx needs.
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

function makeFlight(overrides: Partial<Flight> = {}): Flight {
  return {
    id: 5,
    aircraftId: null,
    simRegistration: 'G-TEST',
    simIcaoType: 'C172',
    simTitle: 'Cessna 172 Classic',
    status: 'completed',
    flightNumber: null,
    depIcao: 'EGLL',
    arrIcao: 'EGKK',
    altnIcao: null,
    routeString: null,
    cruiseAltM: null,
    schedOutUtc: null,
    schedInUtc: null,
    actualOutUtc: '2026-02-01T10:00:00.000Z',
    actualOffUtc: '2026-02-01T10:05:00.000Z',
    actualOnUtc: null,
    actualInUtc: '2026-02-01T12:00:00.000Z',
    blockMinutes: 120,
    airMinutes: 100,
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
    selectedArrivalIcao: null,
    ...overrides
  }
}

function setWinglog(overrides: Partial<WingLogApi> = {}): WingLogApi {
  const api = {
    aircraftCreate: vi.fn().mockResolvedValue({ ...AIRCRAFT, id: 99 }),
    aircraftTypeSearch: vi.fn().mockResolvedValue([]),
    flightLinkAircraft: vi.fn().mockResolvedValue(makeFlight({ aircraftId: 99, simRegistration: null, simIcaoType: null })),
    ...overrides
  } as WingLogApi
  window.winglog = api
  return api
}

function renderDialog(
  props: Partial<Parameters<typeof AddFlightToFleetDialog>[0]> = {}
): ReturnType<typeof render> {
  return render(
    <AddFlightToFleetDialog
      open={props.open ?? true}
      onOpenChange={props.onOpenChange ?? vi.fn()}
      flight={props.flight ?? makeFlight()}
      fleetAircraft={props.fleetAircraft ?? []}
      onLinked={props.onLinked ?? vi.fn()}
    />
  )
}

describe('AddFlightToFleetDialog', () => {
  it('defaults to creating a new aircraft, prefilled from the flight\'s sim-reported identity, when the fleet is empty', () => {
    setWinglog()
    renderDialog({ fleetAircraft: [] })
    expect(screen.getByLabelText('Registration')).toHaveValue('G-TEST')
    expect(screen.queryByText('Aircraft')).not.toBeInTheDocument() // no mode picker with nothing to link to
  })

  it('creates a new fleet aircraft from the edited identity, then links the flight to it', async () => {
    const aircraftCreate = vi.fn().mockResolvedValue({ ...AIRCRAFT, id: 42 })
    const flightLinkAircraft = vi.fn().mockResolvedValue(makeFlight({ aircraftId: 42 }))
    const onLinked = vi.fn()
    const onOpenChange = vi.fn()
    setWinglog({ aircraftCreate, flightLinkAircraft })
    const user = userEvent.setup()
    renderDialog({ fleetAircraft: [], onLinked, onOpenChange, flight: makeFlight({ id: 7 }) })

    await user.clear(screen.getByLabelText('Registration'))
    await user.type(screen.getByLabelText('Registration'), 'N1234')
    await user.click(screen.getByRole('button', { name: 'Add to fleet' }))

    await waitFor(() => expect(aircraftCreate).toHaveBeenCalledWith({ registration: 'N1234', icaoType: 'C172' }))
    await waitFor(() => expect(flightLinkAircraft).toHaveBeenCalledWith(7, 42))
    expect(onLinked).toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('defaults to linking an existing aircraft when the fleet already has one, excluding retired tails', async () => {
    const flightLinkAircraft = vi.fn().mockResolvedValue(makeFlight({ aircraftId: AIRCRAFT.id }))
    setWinglog({ flightLinkAircraft })
    const user = userEvent.setup()
    renderDialog({ fleetAircraft: [AIRCRAFT, RETIRED_AIRCRAFT], flight: makeFlight({ id: 3 }) })

    expect(screen.getByText('G-EUYY — A320')).toBeInTheDocument()
    expect(screen.queryByText(/G-OLD/)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Add to fleet' }))
    await waitFor(() => expect(flightLinkAircraft).toHaveBeenCalledWith(3, AIRCRAFT.id))
  })

  it('lets the pilot switch to "add as new" even when existing fleet aircraft are available', async () => {
    const aircraftCreate = vi.fn().mockResolvedValue({ ...AIRCRAFT, id: 55 })
    setWinglog({ aircraftCreate })
    const user = userEvent.setup()
    renderDialog({ fleetAircraft: [AIRCRAFT] })

    // Two comboboxes are visible in "existing" mode — the mode picker itself, and the
    // existing-aircraft picker it currently shows below it. The mode picker is first.
    await user.click(screen.getAllByRole('combobox')[0])
    await user.click(await screen.findByRole('option', { name: 'Add as a new fleet aircraft' }))
    expect(screen.getByLabelText('Registration')).toHaveValue('G-TEST')

    await user.click(screen.getByRole('button', { name: 'Add to fleet' }))
    await waitFor(() => expect(aircraftCreate).toHaveBeenCalledWith({ registration: 'G-TEST', icaoType: 'C172' }))
  })

  it('requires a registration and type before creating a new aircraft', async () => {
    const aircraftCreate = vi.fn()
    setWinglog({ aircraftCreate })
    const user = userEvent.setup()
    renderDialog({ fleetAircraft: [], flight: makeFlight({ simRegistration: null, simIcaoType: null }) })

    await user.click(screen.getByRole('button', { name: 'Add to fleet' }))
    expect(await screen.findByText('Enter a registration and type for the new aircraft.')).toBeInTheDocument()
    expect(aircraftCreate).not.toHaveBeenCalled()
  })

  it('closes without submitting when Cancel is clicked', async () => {
    const flightLinkAircraft = vi.fn()
    const onOpenChange = vi.fn()
    setWinglog({ flightLinkAircraft })
    const user = userEvent.setup()
    renderDialog({ fleetAircraft: [], onOpenChange })

    await user.click(screen.getByText('Cancel'))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(flightLinkAircraft).not.toHaveBeenCalled()
  })

  it('shows a toast and keeps the dialog open when flightLinkAircraft throws', async () => {
    const { toast } = await import('sonner')
    setWinglog({ flightLinkAircraft: vi.fn().mockRejectedValue(new Error('Aircraft 42 not found or retired')) })
    const onOpenChange = vi.fn()
    const user = userEvent.setup()
    renderDialog({ fleetAircraft: [AIRCRAFT], onOpenChange })

    await user.click(screen.getByRole('button', { name: 'Add to fleet' }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Aircraft 42 not found or retired'))
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })
})
