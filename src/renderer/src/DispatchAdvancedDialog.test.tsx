import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Flight } from '@shared/ipc'
import { defaultDispatchOptions, type DispatchOptions } from '@shared/dispatch-options'
import { DispatchAdvancedDialog } from './DispatchAdvancedDialog'

function flight(overrides: Partial<Flight> = {}): Flight {
  return {
    id: 1,
    aircraftId: 1,
    status: 'planned',
    flightNumber: null,
    depIcao: 'EGLL',
    arrIcao: 'KJFK',
    altnIcao: null,
    routeString: null,
    cruiseAltM: null,
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
    createdAt: '2026-09-01T00:00:00.000Z',
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

function Harness(props: { flights: Flight[]; open?: boolean }): React.JSX.Element {
  const [options, setOptions] = useState<DispatchOptions>(defaultDispatchOptions())
  const [open, setOpen] = useState(props.open ?? true)
  return (
    <DispatchAdvancedDialog
      open={open}
      onOpenChange={setOpen}
      options={options}
      onOptionsChange={setOptions}
      flights={props.flights}
    />
  )
}

describe('DispatchAdvancedDialog', () => {
  it('renders nothing (a closed dialog) when open is false', () => {
    render(<Harness flights={[]} open={false} />)
    expect(screen.queryByText('Advanced dispatch options')).not.toBeInTheDocument()
  })

  it('omits the "Load settings from" section when no flight has a stored OFP', () => {
    render(<Harness flights={[flight({ ofpJson: null })]} />)
    expect(screen.queryByText('Load settings from a previous flight')).not.toBeInTheDocument()
  })

  it('shows the "Load settings from" section only for flights with a stored OFP', () => {
    render(<Harness flights={[flight({ id: 1, ofpJson: null }), flight({ id: 2, ofpJson: '{}' })]} />)
    expect(screen.getByText('Load settings from a previous flight')).toBeInTheDocument()
  })

  it('labels a loadable flight by its flight number, or dep→arr when none is set', async () => {
    const user = userEvent.setup()
    render(
      <Harness
        flights={[
          flight({ id: 1, flightNumber: 'BA123', ofpJson: '{}', createdAt: '2026-09-05T00:00:00.000Z' }),
          flight({ id: 2, flightNumber: null, depIcao: 'EGLL', arrIcao: 'KJFK', ofpJson: '{}', createdAt: '2026-09-06T00:00:00.000Z' })
        ]}
      />
    )

    await user.click(screen.getByRole('combobox'))
    expect(await screen.findByText('BA123 (2026-09-05)')).toBeInTheDocument()
    expect(screen.getByText('EGLL → KJFK (2026-09-06)')).toBeInTheDocument()
  })

  it('loads a flight\'s stored options and shows a confirmation naming it', async () => {
    const user = userEvent.setup()
    const ofpJson = JSON.stringify({
      api_params: { pax: '150', fuelfactor: '1.05' },
      general: { costindex: '25' }
    })
    render(<Harness flights={[flight({ id: 7, flightNumber: 'BA1', ofpJson })]} />)

    await user.click(screen.getByRole('combobox'))
    await user.click(await screen.findByText(/BA1 \(/))

    expect(await screen.findByText(/Loaded from BA1/)).toBeInTheDocument()
    expect(screen.getByLabelText('Passengers')).toHaveValue('150')

    await user.click(screen.getByRole('tab', { name: 'Fuel' }))
    expect(screen.getByLabelText('Fuel factor')).toHaveValue('1.05')

    await user.click(screen.getByRole('tab', { name: 'Cruise' }))
    expect(screen.getByLabelText('Cost index')).toHaveValue('25')
  })

  it('does not show a confirmation when the selected flight\'s OFP has no usable api_params', async () => {
    const user = userEvent.setup()
    render(<Harness flights={[flight({ id: 3, flightNumber: 'NOPARAMS', ofpJson: '{}' })]} />)

    await user.click(screen.getByRole('combobox'))
    await user.click(await screen.findByText(/NOPARAMS \(/))

    expect(screen.queryByText(/Loaded from/)).not.toBeInTheDocument()
  })

  it('falls back to dep→arr for the "Loaded from" note when the flight has no flight number', async () => {
    const user = userEvent.setup()
    const ofpJson = JSON.stringify({ api_params: { pax: '10' }, general: {} })
    render(
      <Harness
        flights={[flight({ id: 9, flightNumber: null, depIcao: 'EGLL', arrIcao: 'KJFK', ofpJson, createdAt: '' })]}
      />
    )

    await user.click(screen.getByRole('combobox'))
    // No createdAt suffix either, since it's an empty string for this fixture.
    expect(await screen.findByText('EGLL → KJFK')).toBeInTheDocument()
    await user.click(screen.getByText('EGLL → KJFK'))

    expect(await screen.findByText('Loaded from EGLL → KJFK — departure date/time was not restored, since it\'s always the one thing worth setting fresh.')).toBeInTheDocument()
  })

  it('lets every field be typed into and cleared back to blank (null)', async () => {
    const user = userEvent.setup()
    render(<Harness flights={[]} />)

    const pax = screen.getByLabelText('Passengers')
    await user.type(pax, '180')
    expect(pax).toHaveValue('180')

    await user.clear(pax)
    expect(pax).toHaveValue('')
  })

  it('accepts the literal "auto" for an auto-eligible field, and shows its placeholder', () => {
    // The Load tab (active by default) has three autoEligible fields (Passengers, Manual
    // ZFW, Manual payload) sharing this placeholder.
    render(<Harness flights={[]} />)
    expect(screen.getAllByPlaceholderText('blank = default, or "auto"').length).toBe(3)
    expect(screen.getAllByPlaceholderText('blank = default').length).toBeGreaterThan(0)
  })

  it('uses a custom placeholder when one is given', async () => {
    const user = userEvent.setup()
    render(<Harness flights={[]} />)

    await user.click(screen.getByRole('tab', { name: 'Fuel' }))
    expect(screen.getByPlaceholderText('e.g. 1.0')).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Cruise' }))
    expect(screen.getByPlaceholderText('e.g. CI, LRC, MMO')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('e.g. 350')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('e.g. 250/320/84')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('e.g. 85/300/250')).toBeInTheDocument()
    // Cruise sub-mode is also autoEligible.
    expect(screen.getByPlaceholderText('blank = default, or "auto"')).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Route' }))
    expect(screen.getByPlaceholderText('leave blank to let SimBrief plan it')).toBeInTheDocument()
  })

  it('switches between the Load/Fuel/Cruise/Route tabs', async () => {
    const user = userEvent.setup()
    render(<Harness flights={[]} />)

    expect(screen.getByLabelText('Passengers')).toBeVisible()

    await user.click(screen.getByRole('tab', { name: 'Fuel' }))
    expect(screen.getByLabelText('Fuel factor')).toBeVisible()

    await user.click(screen.getByRole('tab', { name: 'Cruise' }))
    expect(screen.getByLabelText('Cost index')).toBeVisible()

    await user.click(screen.getByRole('tab', { name: 'Route' }))
    expect(screen.getByLabelText('Route override')).toBeVisible()
    expect(screen.getByLabelText('Departure runway')).toBeVisible()
    expect(screen.getByLabelText('Arrival runway')).toBeVisible()
  })

  it('shows the number of set fields in the Done button, updating as fields change', async () => {
    const user = userEvent.setup()
    render(<Harness flights={[]} />)

    expect(screen.getByText('Done (0 set)')).toBeInTheDocument()

    await user.type(screen.getByLabelText('Passengers'), '180')
    expect(screen.getByText('Done (1 set)')).toBeInTheDocument()
  })

  it('closes the dialog when Done is clicked', async () => {
    const user = userEvent.setup()
    render(<Harness flights={[]} />)

    await user.click(screen.getByText(/Done/))
    expect(screen.queryByText('Advanced dispatch options')).not.toBeInTheDocument()
  })

  it('wires every field on every tab to its own onChange', async () => {
    const user = userEvent.setup()
    render(<Harness flights={[]} />)

    // Load tab (active by default).
    await user.type(screen.getByLabelText('Cargo (kg)'), '500')
    expect(screen.getByLabelText('Cargo (kg)')).toHaveValue('500')
    await user.type(screen.getByLabelText('Manual ZFW'), '60000')
    expect(screen.getByLabelText('Manual ZFW')).toHaveValue('60000')
    await user.type(screen.getByLabelText('Manual payload'), 'auto')
    expect(screen.getByLabelText('Manual payload')).toHaveValue('auto')

    await user.click(screen.getByRole('tab', { name: 'Fuel' }))
    await user.type(screen.getByLabelText('Fuel factor'), '1.05')
    expect(screen.getByLabelText('Fuel factor')).toHaveValue('1.05')
    await user.type(screen.getByLabelText('Extra fuel (kg)'), '200')
    expect(screen.getByLabelText('Extra fuel (kg)')).toHaveValue('200')
    await user.type(screen.getByLabelText('Contingency %'), '5')
    expect(screen.getByLabelText('Contingency %')).toHaveValue('5')
    await user.type(screen.getByLabelText('Reserve rule'), 'auto')
    expect(screen.getByLabelText('Reserve rule')).toHaveValue('auto')
    await user.type(screen.getByLabelText('Taxi out (min)'), '12')
    expect(screen.getByLabelText('Taxi out (min)')).toHaveValue('12')
    await user.type(screen.getByLabelText('Taxi in (min)'), '8')
    expect(screen.getByLabelText('Taxi in (min)')).toHaveValue('8')
    await user.type(screen.getByLabelText('Tankering (kg)'), '300')
    expect(screen.getByLabelText('Tankering (kg)')).toHaveValue('300')

    await user.click(screen.getByRole('tab', { name: 'Cruise' }))
    await user.type(screen.getByLabelText('Cost index'), '25')
    expect(screen.getByLabelText('Cost index')).toHaveValue('25')
    await user.type(screen.getByLabelText('Cruise mode'), 'LRC')
    expect(screen.getByLabelText('Cruise mode')).toHaveValue('LRC')
    await user.type(screen.getByLabelText('Cruise sub-mode'), 'auto')
    expect(screen.getByLabelText('Cruise sub-mode')).toHaveValue('auto')
    await user.type(screen.getByLabelText('Flight level'), '350')
    expect(screen.getByLabelText('Flight level')).toHaveValue('350')
    await user.type(screen.getByLabelText('Climb profile'), '250/320/84')
    expect(screen.getByLabelText('Climb profile')).toHaveValue('250/320/84')
    await user.type(screen.getByLabelText('Descent profile'), '85/300/250')
    expect(screen.getByLabelText('Descent profile')).toHaveValue('85/300/250')

    await user.click(screen.getByRole('tab', { name: 'Route' }))
    // Not "EGLL DCT KJFK": OptionField trims on every keystroke (see its own test below for
    // the resulting quirk), so a space typed mid-string is stripped before the next
    // character lands. A single token avoids that and still exercises the onChange wiring.
    await user.type(screen.getByLabelText('Route override'), 'EGLLDCTKJFK')
    expect(screen.getByLabelText('Route override')).toHaveValue('EGLLDCTKJFK')
    await user.type(screen.getByLabelText('Departure runway'), '27L')
    expect(screen.getByLabelText('Departure runway')).toHaveValue('27L')
    await user.type(screen.getByLabelText('Arrival runway'), '04L')
    expect(screen.getByLabelText('Arrival runway')).toHaveValue('04L')

    // Every field above ends up set, so the Done count reflects all of them regardless of
    // which tab is currently showing.
    expect(screen.getByText('Done (19 set)')).toBeInTheDocument()
  })

  it('resets every field to defaults and clears the "Loaded from" note', async () => {
    const user = userEvent.setup()
    const ofpJson = JSON.stringify({ api_params: { pax: '150' }, general: {} })
    render(<Harness flights={[flight({ id: 7, flightNumber: 'BA1', ofpJson })]} />)

    await user.click(screen.getByRole('combobox'))
    await user.click(await screen.findByText(/BA1 \(/))
    expect(await screen.findByText(/Loaded from BA1/)).toBeInTheDocument()

    await user.click(screen.getByText('Reset to defaults'))

    expect(screen.queryByText(/Loaded from/)).not.toBeInTheDocument()
    expect(screen.getByLabelText('Passengers')).toHaveValue('')
    expect(screen.getByText('Done (0 set)')).toBeInTheDocument()
  })
})
