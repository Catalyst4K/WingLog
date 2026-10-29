import type { ReactNode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LiveTopic, LiveTopics } from '@shared/live'
import type { AtcAirport, AtcArea, NetworkAtc, TrafficLayers } from '@shared/ipc'
import { LiveClientContext, type LiveClient } from './live/LiveClient'

const popups: { lngLat: unknown; content: HTMLElement | null; removed: boolean; close: () => void }[] = []

vi.mock('maplibre-gl', () => ({
  Popup: class {
    closeHandlers: (() => void)[] = []
    state: (typeof popups)[number] = {
      lngLat: null,
      content: null,
      removed: false,
      // The popup's own cross.
      close: () => {
        this.state.removed = true
        this.closeHandlers.forEach((handler) => handler())
      }
    }
    constructor() {
      popups.push(this.state)
    }
    on(_event: 'close', handler: () => void): this {
      this.closeHandlers.push(handler)
      return this
    }
    isOpen(): boolean {
      return !this.state.removed
    }
    remove(): this {
      this.state.removed = true
      this.state.close()
      return this
    }
    setLngLat(at: unknown): this {
      this.state.lngLat = at
      return this
    }
    setDOMContent(content: HTMLElement): this {
      this.state.content = content
      return this
    }
    addTo(): this {
      return this
    }
  }
}))

const {
  useNetworkAtcOverlay,
  ATC_AREAS_SOURCE,
  ATC_LABELS_SOURCE,
  ATC_AIRPORTS_SOURCE,
  ATC_FILL_LAYER,
  ATC_AIRPORT_DOT_LAYER
} = await import('./use-network-atc-overlay')

interface FakeLayer {
  id: string
  type: string
  source: string
  minzoom?: number
}

function fakeMap(existing: string[] = []) {
  const sources = new Map<string, { setData: ReturnType<typeof vi.fn>; spec: Record<string, unknown> }>()
  const layers = new Map<string, FakeLayer>(existing.map((id) => [id, { id, type: 'symbol', source: 'x' }]))
  const placedBefore = new Map<string, string | undefined>()
  const visibility = new Map<string, string>()
  const clicks = new Map<string, (event: unknown) => void>()
  const hovers = new Map<string, () => void>()
  const canvas = { style: { cursor: '' } }
  let underClick: string[] = []
  const map = {
    getCanvas: () => canvas,
    getSource: (id: string) => sources.get(id),
    addSource: vi.fn((id: string, spec: Record<string, unknown>) => {
      sources.set(id, { setData: vi.fn().mockResolvedValue(undefined), spec })
    }),
    addLayer: vi.fn((layer: FakeLayer, before?: string) => {
      layers.set(layer.id, layer)
      placedBefore.set(layer.id, before)
    }),
    getLayer: (id: string) => layers.get(id),
    setLayoutProperty: vi.fn((id: string, name: string, value: string) => {
      if (name === 'visibility') visibility.set(id, value)
    }),
    queryRenderedFeatures: vi.fn(() => underClick.map((id) => ({ layer: { id } }))),
    on: vi.fn((event: string, layerId: string, handler: (event: unknown) => void) => {
      if (event === 'click') clicks.set(layerId, handler)
      else hovers.set(`${event}:${layerId}`, handler as () => void)
    })
  }
  return {
    map,
    sources,
    layers,
    placedBefore,
    visibility,
    clicks,
    hovers,
    canvas,
    putUnderClick: (ids: string[]) => {
      underClick = ids
    }
  }
}

const LAYERS_OFF: TrafficLayers = {
  networkOn: false,
  simOn: false,
  simOffered: true,
  atcOn: false,
  drawNetwork: false,
  drawSim: false,
  drawAtc: false
}
const LAYERS_ON: TrafficLayers = { ...LAYERS_OFF, atcOn: true, drawAtc: true }

const SQUARE = [
  [
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0]
    ]
  ]
]
const CENTRE: AtcArea = {
  id: 'EGTT-C',
  kind: 'centre',
  name: 'London ACC (Central) - London',
  at: [-0.15, 52.178],
  coordinates: SQUARE,
  stations: [{ callsign: 'LON_C_CTR', frequency: '133.700', position: 'ctr', name: null }]
}
const HEATHROW: AtcAirport = {
  icao: 'EGLL',
  at: [-0.4619, 51.4706],
  stations: [{ callsign: 'EGLL_TWR', frequency: '118.500', position: 'twr', name: null }],
  atis: []
}

function shown(areas: AtcArea[] = [CENTRE], airports: AtcAirport[] = [HEATHROW]): NetworkAtc {
  return { network: 'vatsim', state: 'shown', areas, airports }
}

function fakeClient(initial: { atc?: NetworkAtc }) {
  const listeners = new Map<LiveTopic, (payload: never) => void>()
  const client: LiveClient = {
    get: vi.fn((topic: LiveTopic) =>
      Promise.resolve(topic === 'networkAtc' ? initial.atc : undefined)
    ) as LiveClient['get'],
    subscribe: vi.fn((topic: LiveTopic, listener: (payload: never) => void) => {
      listeners.set(topic, listener)
      return () => listeners.delete(topic)
    }) as LiveClient['subscribe'],
    command: vi.fn().mockResolvedValue(undefined)
  }
  const push = <T extends LiveTopic>(topic: T, payload: LiveTopics[T]): void =>
    listeners.get(topic)?.(payload as never)
  return { client, push }
}

async function mount(
  client: LiveClient,
  fake: ReturnType<typeof fakeMap>,
  options: { live?: boolean; mapReady?: boolean; layers?: TrafficLayers | null } = {}
) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <LiveClientContext.Provider value={client}>{children}</LiveClientContext.Provider>
  )
  const mapRef = { current: fake.map as never }
  const view = renderHook(
    (props: { layers: TrafficLayers | null }) =>
      useNetworkAtcOverlay({
        mapRef,
        mapReady: options.mapReady ?? true,
        live: options.live ?? true,
        layers: props.layers
      }),
    { wrapper, initialProps: { layers: options.layers === undefined ? LAYERS_ON : options.layers } }
  )
  await act(async () => {})
  return view
}

/** The features last written to a source. */
function lastFeatures(
  fake: ReturnType<typeof fakeMap>,
  sourceId: string
): { properties: Record<string, unknown> }[] {
  const calls = fake.sources.get(sourceId)?.setData.mock.calls ?? []
  return (calls.at(-1)?.[0] as { features: never[] } | undefined)?.features ?? []
}

describe('useNetworkAtcOverlay', () => {
  beforeEach(() => {
    // A map that is torn down closes its popups, which is what clears the card remembered between tests.
    popups.forEach((popup) => popup.close())
    popups.length = 0
  })
  afterEach(() => vi.clearAllMocks())

  it('touches nothing on the map until the layer first draws', async () => {
    const fake = fakeMap()
    const { client } = fakeClient({ atc: shown() })
    await mount(client, fake, { layers: LAYERS_OFF })
    expect(fake.map.addSource).not.toHaveBeenCalled()
    expect(fake.map.addLayer).not.toHaveBeenCalled()
    expect(fake.map.setLayoutProperty).not.toHaveBeenCalled()
  })

  it('does nothing on a map that is not live, and does not even subscribe', async () => {
    const fake = fakeMap()
    const { client } = fakeClient({ atc: shown() })
    await mount(client, fake, { live: false })
    expect(client.subscribe).not.toHaveBeenCalled()
    expect(fake.map.addSource).not.toHaveBeenCalled()
  })

  it('waits for the map to be ready, and for the layers to say it draws', async () => {
    const fake = fakeMap()
    const { client } = fakeClient({ atc: shown() })
    await mount(client, fake, { mapReady: false })
    await mount(client, fake, { layers: null })
    expect(fake.map.addSource).not.toHaveBeenCalled()
  })

  it('adds three sources and six layers once, with the licence’s attribution on the areas', async () => {
    const fake = fakeMap()
    const { client } = fakeClient({ atc: shown() })
    await mount(client, fake)
    expect([...fake.sources.keys()]).toEqual([ATC_AREAS_SOURCE, ATC_LABELS_SOURCE, ATC_AIRPORTS_SOURCE])
    expect([...fake.layers.keys()]).toEqual([
      'atc-areas-fill',
      'atc-areas-line',
      'atc-labels-centre',
      'atc-labels-approach',
      'atc-airports-dot',
      'atc-airports-letters'
    ])
    expect(fake.sources.get(ATC_AREAS_SOURCE)?.spec.attribution).toMatch(/CC BY-SA 4\.0/)
    expect(fake.sources.get(ATC_AREAS_SOURCE)?.spec.attribution).toMatch(/VAT-Spy/)
  })

  it('draws the areas, their labels and the airports', async () => {
    const fake = fakeMap()
    const { client } = fakeClient({ atc: shown() })
    await mount(client, fake)
    expect(lastFeatures(fake, ATC_AREAS_SOURCE).map((f) => f.properties.kind)).toEqual(['centre'])
    expect(lastFeatures(fake, ATC_LABELS_SOURCE).map((f) => f.properties.label)).toEqual(['LON_C_CTR'])
    expect(
      lastFeatures(fake, ATC_AIRPORTS_SOURCE).map((f) => [f.properties.label, f.properties.letters])
    ).toEqual([['EGLL', 'T']])
  })

  it('goes under the traffic layers when they are already on the map, and on top when they are not', async () => {
    const under = fakeMap(['network-traffic-air', 'sim-traffic-air'])
    await mount(fakeClient({ atc: shown() }).client, under)
    for (const id of ['atc-areas-fill', 'atc-airports-dot', 'atc-airports-letters'])
      expect(under.placedBefore.get(id)).toBe('network-traffic-air')
    const alone = fakeMap()
    await mount(fakeClient({ atc: shown() }).client, alone)
    expect(alone.placedBefore.get('atc-areas-fill')).toBeUndefined()
  })

  it('follows the topic: a new set of controllers is drawn, and nothing is added twice', async () => {
    const fake = fakeMap()
    const { client, push } = fakeClient({ atc: shown() })
    await mount(client, fake)
    await act(async () => push('networkAtc', shown([], [HEATHROW, { ...HEATHROW, icao: 'EGKK' }])))
    expect(lastFeatures(fake, ATC_AREAS_SOURCE)).toEqual([])
    expect(lastFeatures(fake, ATC_AIRPORTS_SOURCE).map((f) => f.properties.label)).toEqual(['EGLL', 'EGKK'])
    expect(fake.map.addSource).toHaveBeenCalledTimes(3)
  })

  it('hides the layers when the layers say it no longer draws, and shows them again', async () => {
    const fake = fakeMap()
    const { client } = fakeClient({ atc: shown() })
    const view = await mount(client, fake)
    view.rerender({ layers: LAYERS_OFF })
    expect(fake.visibility.get('atc-areas-fill')).toBe('none')
    expect(fake.visibility.get('atc-airports-letters')).toBe('none')
    view.rerender({ layers: LAYERS_ON })
    expect(fake.visibility.get('atc-areas-fill')).toBe('visible')
    expect(fake.map.addSource).toHaveBeenCalledTimes(3)
  })

  it.each([['off'], ['noNetwork'], ['needsVid'], ['unavailable']] as const)(
    'draws nothing while the topic says %s',
    async (state) => {
      const fake = fakeMap()
      const { client } = fakeClient({ atc: { network: 'vatsim', state, areas: [], airports: [] } })
      await mount(client, fake)
      expect(fake.map.addSource).not.toHaveBeenCalled()
    }
  )

  it('returns the topic, for the button and the pill', async () => {
    const { client } = fakeClient({ atc: shown() })
    const view = await mount(client, fakeMap())
    expect(view.result.current.atc?.state).toBe('shown')
  })

  describe('clicks', () => {
    async function drawn() {
      const fake = fakeMap()
      await mount(fakeClient({ atc: shown() }).client, fake)
      return fake
    }
    const row = (callsign: string, note: string | null = null) => ({
      tag: 'CTR',
      callsign,
      frequency: '133.700',
      note
    })
    const featureWith = (title: string, rows: ReturnType<typeof row>[] = []) => ({
      properties: { card: JSON.stringify({ title, rows }) }
    })

    it('lays an area out as a title and one aligned row per controller, the name beneath, all as text nodes', async () => {
      const fake = await drawn()
      fake.clicks.get(ATC_FILL_LAYER)?.({
        lngLat: { lng: 1, lat: 2 },
        point: { x: 10, y: 10 },
        features: [featureWith('London ACC', [row('<b>LON_C_CTR</b>', 'Test Controller'), row('LON_CS_CTR')])]
      })
      expect(popups).toHaveLength(1)
      const [title, grid] = Array.from(popups[0]!.content!.children) as HTMLElement[]
      expect(title?.textContent).toBe('London ACC')
      expect(title?.style.fontWeight).toBe('600')
      // Each row is its kind, callsign and frequency across three columns; a name takes its own line under the callsign.
      expect(Array.from(grid!.children).map((cell) => cell.textContent)).toEqual([
        'CTR',
        '<b>LON_C_CTR</b>',
        '133.700',
        'Test Controller',
        'CTR',
        'LON_CS_CTR',
        '133.700'
      ])
      expect(grid?.style.display).toBe('grid')
      expect(popups[0]?.content?.querySelector('b')).toBeNull()
    })

    it('lists the stations of an airport', async () => {
      const fake = await drawn()
      fake.clicks.get(ATC_AIRPORT_DOT_LAYER)?.({
        lngLat: { lng: 1, lat: 2 },
        point: { x: 10, y: 10 },
        features: [featureWith('EGLL', [row('EGLL_TWR')])]
      })
      expect(popups[0]?.content?.textContent).toBe('EGLLCTREGLL_TWR133.700')
    })

    it('takes an airport’s card away on a second click on its marker, and brings it back on a third', async () => {
      const fake = await drawn()
      const clickAirport = (title: string): void =>
        fake.clicks.get(ATC_AIRPORT_DOT_LAYER)?.({
          lngLat: { lng: 1, lat: 2 },
          point: { x: 10, y: 10 },
          features: [featureWith(title, [row(`${title}_TWR`)])]
        })
      clickAirport('EGLL')
      expect(popups.map((popup) => popup.removed)).toEqual([false])
      clickAirport('EGLL')
      expect(popups.map((popup) => popup.removed)).toEqual([true])
      clickAirport('EGLL')
      expect(popups.map((popup) => popup.removed)).toEqual([true, false])
    })

    it('lists every area under the click in one card, the approach ahead of the centre over it, each once', async () => {
      const fake = await drawn()
      const area = (kind: string, title: string, callsign: string) => ({
        properties: { kind, card: JSON.stringify({ title, rows: [row(callsign)] }) }
      })
      const centre = area('centre', 'Hong Kong Radar', 'HKG_CTR')
      const approach = area('approach', 'Hong Kong Approach', 'VHHH_APP')
      fake.clicks.get(ATC_FILL_LAYER)?.({
        lngLat: { lng: 1, lat: 2 },
        point: { x: 10, y: 10 },
        features: [centre, approach, centre]
      })
      expect(popups).toHaveLength(1)
      const sections = Array.from(popups[0]!.content!.children) as HTMLElement[]
      expect(sections.map((section) => section.firstElementChild?.textContent)).toEqual([
        'Hong Kong Approach',
        'Hong Kong Radar'
      ])
      expect(popups[0]?.content?.textContent).toBe(
        'Hong Kong ApproachCTRVHHH_APP133.700Hong Kong RadarCTRHKG_CTR133.700'
      )
      // The same two areas again take the one card away.
      fake.clicks.get(ATC_FILL_LAYER)?.({
        lngLat: { lng: 1, lat: 2 },
        point: { x: 11, y: 11 },
        features: [approach, centre]
      })
      expect(popups[0]?.removed).toBe(true)
      expect(popups).toHaveLength(1)
    })

    it('takes an area’s card away on a second click anywhere inside it, and swaps to another area’s card', async () => {
      const fake = await drawn()
      const clickArea = (title: string, lng: number): void =>
        fake.clicks.get(ATC_FILL_LAYER)?.({
          lngLat: { lng, lat: 2 },
          point: { x: 10, y: 10 },
          features: [featureWith(title, [row('LON_C_CTR')])]
        })
      clickArea('London ACC', 1)
      clickArea('London ACC', 3)
      expect(popups.map((popup) => popup.removed)).toEqual([true])
      clickArea('London ACC', 5)
      clickArea('Scottish ACC', 7)
      expect(popups.map((popup) => popup.removed)).toEqual([true, false, false])
    })

    it('swaps to another airport’s card rather than dismissing, and forgets a card closed by its own button', async () => {
      const fake = await drawn()
      const clickAirport = (title: string): void =>
        fake.clicks.get(ATC_AIRPORT_DOT_LAYER)?.({
          lngLat: { lng: 1, lat: 2 },
          point: { x: 10, y: 10 },
          features: [featureWith(title)]
        })
      clickAirport('EGLL')
      clickAirport('EGKK')
      expect(popups).toHaveLength(2)
      expect(popups[1]?.removed).toBe(false)
      // The pilot closes EGKK's card with its cross (a close event, not our dismissal): the next click opens it afresh.
      popups[1]!.close()
      clickAirport('EGKK')
      expect(popups).toHaveLength(3)
    })

    it('opens the card afresh when the one remembered has gone with its map', async () => {
      const fake = await drawn()
      const click = (): void =>
        fake.clicks.get(ATC_AIRPORT_DOT_LAYER)?.({
          lngLat: { lng: 1, lat: 2 },
          point: { x: 10, y: 10 },
          features: [featureWith('EGLL')]
        })
      click()
      // Gone without a close event reaching us.
      popups[0]!.removed = true
      click()
      expect(popups).toHaveLength(2)
      expect(popups[1]?.removed).toBe(false)
    })

    it('gives a card with no controllers just its title', async () => {
      const fake = await drawn()
      fake.clicks.get(ATC_AIRPORT_DOT_LAYER)?.({
        lngLat: { lng: 1, lat: 2 },
        point: { x: 10, y: 10 },
        features: [featureWith('EGLL')]
      })
      expect(popups[0]?.content?.textContent).toBe('EGLL')
    })

    it('leaves a click on an airport’s marker or an aircraft to them, not the area under it', async () => {
      const fake = await drawn()
      for (const under of [[ATC_AIRPORT_DOT_LAYER], ['network-traffic-air']]) {
        fake.layers.set('network-traffic-air', { id: 'network-traffic-air', type: 'symbol', source: 'x' })
        fake.putUnderClick(under)
        fake.clicks.get(ATC_FILL_LAYER)?.({
          lngLat: { lng: 1, lat: 2 },
          point: { x: 10, y: 10 },
          features: [featureWith('London ACC')]
        })
      }
      expect(popups).toHaveLength(0)
    })

    it('opens nothing for a feature with no card', async () => {
      const fake = await drawn()
      fake.clicks.get(ATC_FILL_LAYER)?.({
        lngLat: { lng: 1, lat: 2 },
        point: { x: 1, y: 1 },
        features: [{ properties: {} }]
      })
      fake.clicks.get(ATC_FILL_LAYER)?.({ lngLat: { lng: 1, lat: 2 }, point: { x: 1, y: 1 } })
      expect(popups).toHaveLength(0)
    })

    it('shows the pointing hand over an airport’s marker, and puts it back', async () => {
      const fake = await drawn()
      fake.hovers.get(`mouseenter:${ATC_AIRPORT_DOT_LAYER}`)?.()
      expect(fake.canvas.style.cursor).toBe('pointer')
      fake.hovers.get(`mouseleave:${ATC_AIRPORT_DOT_LAYER}`)?.()
      expect(fake.canvas.style.cursor).toBe('')
    })
  })
})
