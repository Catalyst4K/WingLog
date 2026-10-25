import { describe, expect, it } from 'vitest'
import { asOnlineNetwork, extractPrefileUrl } from './prefile-url'

// The shape of a real OFP's prefile block, with an invented route (no real plan or pilot).
const VATSIM_LINK =
  'https://my.vatsim.net/pilots/flightplan?raw=%28FPL-TST123-IS-A320%2FM-SDE2E3FGHIRWY%2FLB1-EGLL1000-N0450F350+DCT-LFPG0100+EGKK%29&fuel_time=0300'
const IVAO_LINK = 'https://fpl.ivao.aero/flight-plans/create?flightPlan=%28FPL-TST123-IS%29'

function ofp(prefile: unknown): string {
  return JSON.stringify({ general: { flight_number: '123' }, prefile })
}

const REAL_SHAPE = ofp({
  vatsim: { name: 'VATSIM', link: VATSIM_LINK },
  ivao: { name: 'IVAO', link: IVAO_LINK },
  pilotedge: { name: 'PilotEdge', link: 'https://example.invalid/not-used' }
})

describe('extractPrefileUrl', () => {
  it('reads each network’s own link from a real-shaped OFP', () => {
    expect(extractPrefileUrl(REAL_SHAPE, 'vatsim')).toBe(VATSIM_LINK)
    expect(extractPrefileUrl(REAL_SHAPE, 'ivao')).toBe(IVAO_LINK)
  })

  it('never gives the other network’s link', () => {
    const vatsimOnly = ofp({ vatsim: { link: VATSIM_LINK } })
    expect(extractPrefileUrl(vatsimOnly, 'ivao')).toBeNull()
  })

  it.each([
    ['a plain http link', 'http://my.vatsim.net/pilots/flightplan?raw=x'],
    ['another host', 'https://evil.example/pilots/flightplan?raw=x'],
    ['a look-alike host', 'https://my.vatsim.net.evil.example/pilots/flightplan?raw=x'],
    ['a login in front of the host', 'https://my.vatsim.net@evil.example/pilots/flightplan?raw=x'],
    ['a login before the real host', 'https://user:pw@my.vatsim.net/pilots/flightplan?raw=x'],
    ['an explicit port', 'https://my.vatsim.net:8443/pilots/flightplan?raw=x'],
    ['a javascript link', 'javascript:alert(1)'],
    ['a file link', 'file:///etc/passwd'],
    ['a data link', 'data:text/html,<script>alert(1)</script>'],
    ['a different page on the host', 'https://my.vatsim.net/account/settings'],
    ['a path that only looks like the page', 'https://my.vatsim.net/other/pilots/flightplan'],
    ['text that is not a link', 'not a link'],
    ['an empty link', '']
  ])('refuses VATSIM %s', (_name, link) => {
    expect(extractPrefileUrl(ofp({ vatsim: { link } }), 'vatsim')).toBeNull()
  })

  it.each([
    ['a plain http link', 'http://fpl.ivao.aero/flight-plans/create?flightPlan=x'],
    ['another host', 'https://fpl.ivao.aero.evil.example/flight-plans/create'],
    ['the VATSIM host', 'https://my.vatsim.net/pilots/flightplan?raw=x'],
    ['a login in the link', 'https://a:b@fpl.ivao.aero/flight-plans/create'],
    ['a wrong path', 'https://fpl.ivao.aero/login']
  ])('refuses IVAO %s', (_name, link) => {
    expect(extractPrefileUrl(ofp({ ivao: { link } }), 'ivao')).toBeNull()
  })

  it.each([
    ['no OFP', null],
    ['text that is not JSON', '{not json'],
    ['JSON that is not an object', '"x"'],
    ['an OFP with no prefile block', JSON.stringify({ general: {} })],
    ['a prefile block that is a list', ofp([])],
    ['a network with no link', ofp({ vatsim: {} })],
    ['a link that is not text', ofp({ vatsim: { link: 5 } })],
    ['a link that is an object', ofp({ vatsim: { link: { href: VATSIM_LINK } } })]
  ])('is null for %s', (_name, raw) => {
    expect(extractPrefileUrl(raw as string | null, 'vatsim')).toBeNull()
  })

  it('keeps a link’s query exactly as SimBrief built it', () => {
    expect(extractPrefileUrl(REAL_SHAPE, 'vatsim')).toContain('fuel_time=0300')
  })
})

describe('asOnlineNetwork', () => {
  it('accepts the two networks and nothing else', () => {
    expect(asOnlineNetwork('vatsim')).toBe('vatsim')
    expect(asOnlineNetwork('ivao')).toBe('ivao')
    for (const bad of ['VATSIM', 'poscon', '', null, undefined, 5, {}])
      expect(asOnlineNetwork(bad)).toBeNull()
  })
})
