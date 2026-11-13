import type { LookupAddress } from 'node:dns'
import { describe, expect, it, vi } from 'vitest'
import { homeNetworkLookup } from './home-lookup'

/** A resolver that answers every name with these addresses, and records what it was asked. */
function resolver(addresses: LookupAddress[] | Error) {
  return vi.fn(
    (
      _hostname: string,
      _options: { all: true },
      callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void
    ) => {
      if (addresses instanceof Error) callback(addresses, [])
      else callback(null, addresses)
    }
  )
}

/** Runs a lookup and gives back what it called back with. */
function run(
  lookup: ReturnType<typeof homeNetworkLookup>,
  hostname: string,
  options: { all?: boolean } = {}
): Promise<{ error: NodeJS.ErrnoException | null; address: unknown; family: number | undefined }> {
  return new Promise((resolve) => {
    lookup(hostname, options, (error, address, family) => resolve({ error, address, family }))
  })
}

const v4 = (address: string): LookupAddress => ({ address, family: 4 })
const v6 = (address: string): LookupAddress => ({ address, family: 6 })

describe('homeNetworkLookup (audit L8)', () => {
  it('lets a name that resolves to a private address connect, to the address it checked', async () => {
    const resolve = resolver([v4('192.168.1.20')])
    const result = await run(homeNetworkLookup(resolve), 'simpc')
    expect(result).toEqual({ error: null, address: '192.168.1.20', family: 4 })
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('answers with every address when the socket asks for all of them', async () => {
    const result = await run(homeNetworkLookup(resolver([v4('10.0.0.5'), v6('fe80::1')])), 'simpc.local', {
      all: true
    })
    expect(result.error).toBeNull()
    expect(result.address).toEqual([v4('10.0.0.5'), v6('fe80::1')])
  })

  it('refuses a name that resolves to a public address, saying which', async () => {
    const result = await run(homeNetworkLookup(resolver([v4('93.184.216.34')])), 'simpc')
    expect(result.error?.message).toContain('outside the home network (93.184.216.34)')
    expect(result.error?.code).toBe('EHOSTNOTHOME')
    expect(result.address).toEqual([])
  })

  it('hands on only the home-network addresses of a name that also has a public one (review of L8)', async () => {
    const mixed = resolver([v6('2606:4700::1111'), v4('192.168.1.20'), v4('93.184.216.34'), v6('fe80::1')])
    expect(await run(homeNetworkLookup(mixed), 'simpc', { all: true })).toEqual({
      error: null,
      address: [v4('192.168.1.20'), v6('fe80::1')],
      family: undefined
    })
    // Asked for one address, it gives the first home one, never the public one listed before it.
    expect(await run(homeNetworkLookup(mixed), 'simpc')).toEqual({
      error: null,
      address: '192.168.1.20',
      family: 4
    })
  })

  it('refuses a name whose every address is outside the home network, naming them', async () => {
    const result = await run(
      homeNetworkLookup(resolver([v4('93.184.216.34'), v6('2606:4700::1111')])),
      'simpc',
      {
        all: true
      }
    )
    expect(result.error?.message).toContain('93.184.216.34, 2606:4700::1111')
    expect(result.address).toEqual([])
  })

  it('refuses a name that resolves to nothing', async () => {
    const result = await run(homeNetworkLookup(resolver([])), 'simpc')
    expect(result.error?.message).toContain('did not resolve')
  })

  it('passes a failed lookup on as it came', async () => {
    const failure = Object.assign(new Error('getaddrinfo ENOTFOUND simpc'), { code: 'ENOTFOUND' })
    const result = await run(homeNetworkLookup(resolver(failure)), 'simpc')
    expect(result.error).toBe(failure)
  })

  it('needs no lookup for a private address typed as a number, and refuses a public one without looking', async () => {
    const resolve = resolver([])
    const lookup = homeNetworkLookup(resolve)
    expect(await run(lookup, '192.168.1.20')).toEqual({ error: null, address: '192.168.1.20', family: 4 })
    expect(await run(lookup, '192.168.1.20', { all: true })).toMatchObject({
      address: [{ address: '192.168.1.20', family: 4 }]
    })
    expect(await run(lookup, 'fe80::1')).toEqual({ error: null, address: 'fe80::1', family: 6 })
    expect((await run(lookup, '8.8.8.8')).error?.message).toContain('8.8.8.8')
    expect(resolve).not.toHaveBeenCalled()
  })
})
