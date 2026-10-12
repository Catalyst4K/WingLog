import { describe, expect, it } from 'vitest'
import { LanConnection, type LinkSocket } from './lan-connection'
import { lanLiveClient } from './lan-live-client'

class FakeSocket implements LinkSocket {
  readyState = 1
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  sent: unknown[] = []
  send(text: string): void {
    this.sent.push(JSON.parse(text))
  }
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
  return { link, say, sent: sockets[0].sent }
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

  it('sends a command to the PC when connected, and rejects when it is not', async () => {
    const { link, say, sent } = connectedLink()
    await expect(lanLiveClient(link).command('gsx.toggleMenu')).rejects.toThrow('Not connected')
    say({ t: 'snapshot', topics: {}, flight: null })
    await expect(lanLiveClient(link).command('gsx.pickMenu', 2)).resolves.toBeUndefined()
    expect(sent.at(-1)).toEqual({ t: 'cmd', name: 'gsx.pickMenu', args: [2] })
  })
})
