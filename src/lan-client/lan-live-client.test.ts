import { describe, expect, it } from 'vitest'
import { LanConnection, type LinkSocket } from './lan-connection'
import { lanLiveClient } from './lan-live-client'

class FakeSocket implements LinkSocket {
  readyState = 1
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  send(): void {}
  close(): void {}
}

function connectedLink() {
  const sockets: FakeSocket[] = []
  const link = new LanConnection(
    'ws://pc/live',
    { get: () => 'tok', set: () => undefined, clear: () => undefined },
    () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
    'iPad'
  )
  link.start()
  const say = (message: unknown): void => sockets[0].onmessage?.({ data: JSON.stringify(message) })
  return { link, say }
}

describe('lanLiveClient', () => {
  it('reads a topic from the link and follows it', async () => {
    const { link, say } = connectedLink()
    const client = lanLiveClient(link)
    expect(await client.get('simConnectionStatus')).toBeUndefined()
    say({ t: 'snapshot', topics: { simConnectionStatus: { state: 'connected' } }, flight: null })
    expect(await client.get('simConnectionStatus')).toEqual({ state: 'connected' })

    const seen: unknown[] = []
    const stop = client.subscribe('simConnectionStatus', (s) => seen.push(s))
    say({ t: 'topic', name: 'simConnectionStatus', payload: { state: 'disconnected' } })
    stop()
    say({ t: 'topic', name: 'simConnectionStatus', payload: { state: 'connected' } })
    expect(seen).toEqual([{ state: 'disconnected' }])
  })

  it('refuses every command: the page is view-only', async () => {
    const { link } = connectedLink()
    await expect(lanLiveClient(link).command('gsx.toggleMenu')).rejects.toThrow('view-only')
  })
})
