import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AirportOption, WingLogApi } from '@shared/ipc'
import { AirportSearch } from './AirportSearch'

const HEATHROW: AirportOption = { icao: 'EGLL', name: 'Heathrow', municipality: 'London', isoCountry: 'GB' }
const NO_MUNICIPALITY: AirportOption = { icao: 'ZZZZ', name: 'Nowhere Field', municipality: null, isoCountry: 'ZZ' }

function Harness(): React.JSX.Element {
  const [value, setValue] = useState('')
  return <AirportSearch value={value} onChange={setValue} />
}

describe('AirportSearch', () => {
  it('uses the default placeholder when none is given', () => {
    render(<Harness />)
    expect(screen.getByPlaceholderText('ICAO or search by name')).toBeInTheDocument()
  })

  it('uses a custom placeholder when given one', () => {
    render(<AirportSearch value="" onChange={vi.fn()} placeholder="Enter an ICAO code" />)
    expect(screen.getByPlaceholderText('Enter an ICAO code')).toBeInTheDocument()
  })

  it('uppercases whatever value it receives before calling onChange', async () => {
    window.winglog = { airportSearch: vi.fn().mockResolvedValue([]) } as unknown as WingLogApi
    const user = userEvent.setup()
    const onChange = vi.fn()
    // Uncontrolled on purpose: value stays '' across the single keystroke below, so
    // e.target.value is exactly the one typed character — isolates the toUpperCase()
    // transform from Combobox's own controlled-input re-render behavior.
    render(<AirportSearch value="" onChange={onChange} />)

    await user.type(screen.getByRole('textbox'), 'e')

    expect(onChange).toHaveBeenCalledWith('E')
  })

  it('wires window.winglog.airportSearch as the search function', async () => {
    const search = vi.fn().mockResolvedValue([HEATHROW])
    window.winglog = { airportSearch: search } as unknown as WingLogApi
    const user = userEvent.setup()
    render(<Harness />)

    await user.type(screen.getByRole('textbox'), 'eg')

    await waitFor(() => expect(search).toHaveBeenCalled(), { timeout: 2000 })
  }, 10000)

  it('labels a result without a municipality using just the country', async () => {
    window.winglog = { airportSearch: vi.fn().mockResolvedValue([NO_MUNICIPALITY]) } as unknown as WingLogApi
    const user = userEvent.setup()
    render(<Harness />)

    await user.type(screen.getByRole('textbox'), 'zz')

    expect(await screen.findByText('ZZZZ — Nowhere Field (ZZ)', {}, { timeout: 2000 })).toBeInTheDocument()
  })

  it('labels a result with a municipality using "(municipality, country)"', async () => {
    window.winglog = { airportSearch: vi.fn().mockResolvedValue([HEATHROW]) } as unknown as WingLogApi
    const user = userEvent.setup()
    render(<Harness />)

    await user.type(screen.getByRole('textbox'), 'eg')

    expect(await screen.findByText('EGLL — Heathrow (London, GB)', {}, { timeout: 2000 })).toBeInTheDocument()
  })

  it('picking a result fills the field with its (already-uppercase) ICAO code', async () => {
    window.winglog = { airportSearch: vi.fn().mockResolvedValue([HEATHROW]) } as unknown as WingLogApi
    const user = userEvent.setup()
    render(<Harness />)

    await user.type(screen.getByRole('textbox'), 'eg')
    await user.click(await screen.findByText('EGLL — Heathrow (London, GB)', {}, { timeout: 2000 }))

    expect(screen.getByRole('textbox')).toHaveValue('EGLL')
  })
})
