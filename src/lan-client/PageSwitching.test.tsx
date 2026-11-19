/** Moving between the pages on the phone with the sim, GSX and BeyondATC all off: the PC answers the lookups, and has no live data to push. */

import { describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LanApp } from './LanApp'
import { installWindowShim } from './window-shim'
import { LanConnection, type LinkSocket, type TokenStore } from '@shared/lan-connection'

// The map needs WebGL (jsdom has none): FlightMap.test.tsx and the acceptance test cover it.
vi.mock('@/FlightMap', () => ({ FlightMap: () => <div data-testid="map" /> }))

/** What the PC answers to the lookups the pages ask: both add-ons switched on, no routines. */
const ANSWERS: Record<string, unknown> = {
  'settings.display': { weightUnit: 'kg', altitudeUnit: 'ft', windSpeedUnit: 'kt', mapLanguage: 'en' },
  'settings.gsxRemote': { enabled: true, host: '', port: 1 },
  'settings.beyondAtc': { enabled: true, host: '' },
  'gsx.routines': []
}

/** The PC end of the link: answers each lookup a moment after it is asked, as the real one does. */
class PcSocket implements LinkSocket {
  readyState = 1
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  send(text: string): void {
    const message = JSON.parse(text) as { t: string; id: number; name: string }
    if (message.t !== 'query') return
    setTimeout(() => {
      const reply = { t: 'result', id: message.id, data: ANSWERS[message.name] }
      this.onmessage?.({ data: JSON.stringify(reply) })
    }, 0)
  }
  close(): void {
    this.onclose?.()
  }
}

/** Opens the page the way the phone does: the real `window.winglog` stand-in over the link, and a PC with nothing running. */
function openPhone(): void {
  const store: TokenStore = { get: () => 'tok', set: () => undefined, clear: () => undefined }
  const sockets: PcSocket[] = []
  const link = new LanConnection(
    'ws://pc/live',
    store,
    () => {
      const socket = new PcSocket()
      sockets.push(socket)
      return socket
    },
    'iPhone'
  )
  installWindowShim(link)
  link.start()
  render(<LanApp link={link} />)
  act(() => {
    sockets[0].onopen?.()
    sockets[0].onmessage?.({ data: JSON.stringify({ t: 'snapshot', topics: {}, flight: null }) })
  })
}

async function goTo(name: string): Promise<void> {
  await userEvent.click(await screen.findByRole('button', { name }))
}

describe('moving between the ground services and BeyondATC pages on the phone', () => {
  it('shows BeyondATC when it is opened after the ground services page', async () => {
    openPhone()
    await goTo('Ground services')
    expect(await screen.findByText('Not connected to GSX.')).toBeInTheDocument()
    await goTo('BeyondATC')
    expect(await screen.findByText('Not connected to BeyondATC.')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('keeps the page and its bar when the ground services page is left for Track', async () => {
    openPhone()
    await goTo('Ground services')
    expect(await screen.findByText('Not connected to GSX.')).toBeInTheDocument()
    await goTo('Track')
    await waitFor(() => expect(screen.getByTestId('map')).toBeVisible())
    expect(screen.getByRole('navigation', { name: 'Pages' })).toBeInTheDocument()
  })
})
