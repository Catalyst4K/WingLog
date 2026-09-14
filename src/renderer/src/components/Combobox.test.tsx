import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Combobox } from './Combobox'

interface Airport {
  icao: string
  name: string
}

function Harness(props: { search: (query: string) => Promise<Airport[]> }): React.JSX.Element {
  const [value, setValue] = useState('')
  const [picked, setPicked] = useState<Airport | null>(null)
  return (
    <div>
      <Combobox<Airport>
        value={value}
        onChange={setValue}
        search={props.search}
        getOptionKey={(a) => a.icao}
        getOptionValue={(a) => a.icao}
        getOptionLabel={(a) => `${a.icao} — ${a.name}`}
        onSelectItem={setPicked}
        placeholder="Airport"
      />
      <span>picked: {picked?.icao ?? 'none'}</span>
    </div>
  )
}

// Real timers throughout — the component's 300ms debounce is short enough to just wait out
// for real, and mixing userEvent with fake timers around a promise-returning `search` proved
// flaky (userEvent's own internals need real timers to settle between keystrokes).
describe('Combobox', () => {
  it('does not search for fewer than 2 characters', async () => {
    const search = vi.fn().mockResolvedValue([])
    const user = userEvent.setup()
    render(<Harness search={search} />)

    await user.type(screen.getByRole('textbox'), 'E')
    await new Promise((resolve) => setTimeout(resolve, 350))

    expect(search).not.toHaveBeenCalled()
  }, 10000)

  it('debounces and searches after 2+ characters', async () => {
    const search = vi.fn().mockResolvedValue([{ icao: 'EGLL', name: 'Heathrow' }])
    const user = userEvent.setup()
    render(<Harness search={search} />)

    await user.type(screen.getByRole('textbox'), 'EG')

    expect(await screen.findByText('EGLL — Heathrow', {}, { timeout: 2000 })).toBeInTheDocument()
    expect(search).toHaveBeenCalledWith('EG')
  }, 10000)

  it('only issues one search for rapid keystrokes (debounced, not one per keystroke)', async () => {
    const search = vi.fn().mockResolvedValue([])
    const user = userEvent.setup()
    render(<Harness search={search} />)

    await user.type(screen.getByRole('textbox'), 'EGLL')
    await waitFor(() => expect(search).toHaveBeenCalled(), { timeout: 2000 })

    expect(search).toHaveBeenCalledTimes(1)
    expect(search).toHaveBeenCalledWith('EGLL')
  }, 10000)

  it('picking a result sets the field value and fires onSelectItem, then closes the dropdown', async () => {
    const search = vi.fn().mockResolvedValue([{ icao: 'EGLL', name: 'Heathrow' }])
    const user = userEvent.setup()
    render(<Harness search={search} />)

    await user.type(screen.getByRole('textbox'), 'EG')
    await user.click(await screen.findByText('EGLL — Heathrow', {}, { timeout: 2000 }))

    expect(screen.getByRole('textbox')).toHaveValue('EGLL')
    expect(screen.getByText('picked: EGLL')).toBeInTheDocument()
    expect(screen.queryByText('EGLL — Heathrow')).not.toBeInTheDocument()
  }, 10000)

  it('shows a "Searching…" indicator while the search promise is pending', async () => {
    let resolveSearch: (value: Airport[]) => void = () => {}
    const search = vi.fn(
      () =>
        new Promise<Airport[]>((resolve) => {
          resolveSearch = resolve
        })
    )
    const user = userEvent.setup()
    render(<Harness search={search} />)

    await user.type(screen.getByRole('textbox'), 'EG')

    expect(await screen.findByText('Searching…', {}, { timeout: 2000 })).toBeInTheDocument()
    resolveSearch([])
    await waitFor(() => expect(screen.queryByText('Searching…')).not.toBeInTheDocument())
  }, 10000)

  it('clears stale results once the query is emptied back out', async () => {
    const search = vi.fn().mockResolvedValue([{ icao: 'EGLL', name: 'Heathrow' }])
    const user = userEvent.setup()
    render(<Harness search={search} />)

    await user.type(screen.getByRole('textbox'), 'EG')
    expect(await screen.findByText('EGLL — Heathrow', {}, { timeout: 2000 })).toBeInTheDocument()

    await user.clear(screen.getByRole('textbox'))
    await waitFor(() => expect(screen.queryByText('EGLL — Heathrow')).not.toBeInTheDocument(), { timeout: 2000 })
  }, 10000)
})
