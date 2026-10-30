import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { BeyondAtcAtisList, WingLogApi } from '@shared/ipc'
import { BeyondAtcAtisButton } from './BeyondAtcAtis'

function withAtis(list: BeyondAtcAtisList | Error) {
  const beyondAtcGetAtis = vi.fn(() => (list instanceof Error ? Promise.reject(list) : Promise.resolve(list)))
  window.winglog = {
    beyondAtcGetAtis,
    appLogRendererError: vi.fn().mockResolvedValue(undefined)
  } as unknown as WingLogApi
  return beyondAtcGetAtis
}

const EGLL = {
  icao: 'EGLL',
  code: 'R',
  text: 'EGLL ATIS R 2338Z ARR RWY 27 RIGHT DEP RWY 27 LEFT <b>READBACK</b>',
  arrivalRunways: ['27R'],
  departureRunways: ['27L']
}
const WSSS = {
  icao: 'WSSS',
  code: null,
  text: 'WSSS ATIS 2338Z',
  arrivalRunways: [],
  departureRunways: []
}

describe('BeyondAtcAtisButton', () => {
  it('asks BeyondATC each time it opens, and shows each airport with its runways and its text', async () => {
    const get = withAtis({ state: 'shown', airports: [EGLL, WSSS] })
    render(<BeyondAtcAtisButton />)
    expect(get).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'ATIS…' }))
    expect(await screen.findByText('EGLL · BeyondATC ATIS R')).toBeInTheDocument()
    expect(screen.getByText('departure runway 27L')).toBeInTheDocument()
    expect(screen.getByText('arrival runway 27R')).toBeInTheDocument()
    expect(screen.getByText('WSSS')).toBeInTheDocument()
    // Drawn as text, never as markup.
    expect(screen.getByText(/<b>READBACK<\/b>/)).toBeInTheDocument()
    expect(document.querySelector('b')).toBeNull()
    expect(get).toHaveBeenCalledTimes(1)

    await userEvent.keyboard('{Escape}')
    await userEvent.click(screen.getByRole('button', { name: 'ATIS…' }))
    await screen.findByText('EGLL · BeyondATC ATIS R')
    expect(get).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['off', 'BeyondATC is not connected.'],
    ['unavailable', 'BeyondATC did not answer. Try again.']
  ] as const)('says so when BeyondATC is %s', async (state, text) => {
    withAtis({ state, airports: [] })
    render(<BeyondAtcAtisButton />)
    await userEvent.click(screen.getByRole('button', { name: 'ATIS…' }))
    expect(await screen.findByText(text)).toBeInTheDocument()
  })

  it('says when BeyondATC answered with no ATIS at all', async () => {
    withAtis({ state: 'shown', airports: [] })
    render(<BeyondAtcAtisButton />)
    await userEvent.click(screen.getByRole('button', { name: 'ATIS…' }))
    expect(await screen.findByText('BeyondATC has no ATIS for this flight.')).toBeInTheDocument()
  })

  it('shows that it is asking until the answer arrives', async () => {
    const pending = new Promise<BeyondAtcAtisList>(() => {})
    window.winglog = {
      beyondAtcGetAtis: vi.fn(() => pending),
      appLogRendererError: vi.fn()
    } as unknown as WingLogApi
    render(<BeyondAtcAtisButton />)
    await userEvent.click(screen.getByRole('button', { name: 'ATIS…' }))
    expect(await screen.findByText('Asking BeyondATC…')).toBeInTheDocument()
  })

  it('reports a failed call instead of throwing, and keeps showing that it is asking', async () => {
    withAtis(new Error('ipc broke'))
    render(<BeyondAtcAtisButton />)
    await userEvent.click(screen.getByRole('button', { name: 'ATIS…' }))
    await vi.waitFor(() =>
      expect(
        (window.winglog as unknown as { appLogRendererError: ReturnType<typeof vi.fn> }).appLogRendererError
      ).toHaveBeenCalled()
    )
  })
})
