import type { ReactNode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LiveTopic, LiveTopics } from '@shared/live'
import type { NetworkTraffic, SimTraffic, TrafficAircraft, TrafficLayers } from '@shared/ipc'
import { LiveClientContext, type LiveClient } from './live/LiveClient'

const popups: { lngLat: unknown; content: HTMLElement | null }[] = []

vi.mock('maplibre-gl', () => ({
  Popup: class {
    state: { lngLat: unknown; content: HTMLElement | null } = { lngLat: null, content: null }
    constructor() {
      popups.push(this.state)
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

const { useNetworkTrafficOverlay, GLIDE_INTERVAL_MS } = await import('./use-network-traffic-overlay')

interface FakeLayer {
  id: string
  filter: unknown
  layout: Record<string, unknown>
  paint: Record<string, unknown>
}

function fakeMap() {
  const sources = new Map<string, { setData: ReturnType<typeof vi.fn> }>()
  const layers = new Map<string, FakeLayer>()
  const visibility = new Map<string, string>()
  const clicks = new Map<string, (event: unknown) => void>()
  const hovers = new Map<string, () => void>()
  const canvas = { style: { cursor: '' } }
  const images: string[] = []
  const map = {
    getCanvas: () => canvas,
    getSource: (id: string) => sources.get(id),
    addSource: vi.fn((id: string) => {
      sources.set(id, { setData: vi.fn().mockResolvedValue(undefined) })
    }),
    addLayer: vi.fn((layer: FakeLayer) => {
      layers.set(layer.id, layer)
    }),
    getLayer: (id: string) => layers.get(id),
    setLayoutProperty: vi.fn((id: string, name: string, value: string) => {
      if (name === 'visibility') visibility.set(id, value)
    }),
    hasImage: (id: string) => images.includes(id),
    addImage: vi.fn((id: string) => {
      images.push(id)
    }),
    on: vi.fn((event: string, layerId: string, handler: (event: unknown) => void) => {
      if (event === 'click') clicks.set(layerId, handler)
      else hovers.set(`${event}:${layerId}`, handler as () => void)
    })
  }
  return { map, sources, layers, visibility, clicks, hovers, canvas }
}

const LAYERS_OFF: TrafficLayers = {
  networkOn: false,
  simOn: false,
  simOffered: true,
  drawNetwork: false,
  drawSim: false
}
const LAYERS_ON: TrafficLayers = { ...LAYERS_OFF, networkOn: true, drawNetwork: true }

function aircraft(callsign: string, changes: Partial<TrafficAircraft> = {}): TrafficAircraft {
  return {
    key: callsign,
    callsign,
    latitude: 51,
    longitude: -1,
    altitudeM: 10_000,
    groundSpeedMs: 200,
    headingDeg: 90,
    onGround: false,
    aircraftIcao: 'A320',
    departure: 'EGLL',
    arrival: 'LFPG',
    ageS: 0,
    ...changes
  }
}

function shown(...list: TrafficAircraft[]): NetworkTraffic {
  return { network: 'vatsim', state: 'shown', aircraft: list }
}

/** A live client the test pushes topics through. */
function fakeClient(initial: { traffic?: NetworkTraffic; layers?: TrafficLayers; sim?: SimTraffic }) {
  const listeners = new Map<LiveTopic, (payload: never) => void>()
  const client: LiveClient = {
    get: vi.fn((topic: LiveTopic) =>
      Promise.resolve(
        topic === 'networkTraffic'
          ? initial.traffic
          : topic === 'trafficLayers'
            ? initial.layers
            : topic === 'simTraffic'
              ? initial.sim
              : undefined
      )
    ) as LiveClient['get'],
    subscribe: vi.fn((topic: LiveTopic, listener: (payload: never) => void) => {
      listeners.set(topic, listener)
      return () => listeners.delete(topic)
    }) as LiveClient['subscribe'],
    command: vi.fn().mockResolvedValue(undefined)
  }
  const push = <T extends LiveTopic>(topic: T, payload: LiveTopics[T]): void =>
    listeners.get(topic)?.(payload as never)
  return { client, push, listeners }
}

async function mount(
  client: LiveClient,
  fake: ReturnType<typeof fakeMap>,
  options: { live?: boolean; mapReady?: boolean } = {}
) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <LiveClientContext.Provider value={client}>{children}</LiveClientContext.Provider>
  )
  const mapRef = { current: fake.map as never }
  const view = renderHook(
    () =>
      useNetworkTrafficOverlay({ mapRef, mapReady: options.mapReady ?? true, live: options.live ?? true }),
    { wrapper }
  )
  await act(async () => {})
  return view
}

/** The features last written to the traffic source. */
function lastFeatures(
  fake: ReturnType<typeof fakeMap>,
  sourceId = 'network-traffic'
): { properties: Record<string, unknown>; geometry: { coordinates: number[] } }[] {
  const calls = fake.sources.get(sourceId)?.setData.mock.calls ?? []
  return (calls.at(-1)?.[0] as { features: never[] } | undefined)?.features ?? []
}

describe('useNetworkTrafficOverlay', () => {
  beforeEach(() => {
    popups.length = 0
    vi.useFakeTimers()
  })
  afterEach(() => vi.useRealTimers())

  it('touches nothing on the map until the layer first draws', async () => {
    const fake = fakeMap()
    const { client } = fakeClient({
      traffic: { network: 'vatsim', state: 'off', aircraft: [] },
      layers: LAYERS_OFF
    })
    await mount(client, fake)
    expect(fake.map.addSource).not.toHaveBeenCalled()
    expect(fake.map.addLayer).not.toHaveBeenCalled()
    expect(fake.map.setLayoutProperty).not.toHaveBeenCalled()
  })

  it('does nothing on a map that is not live, and does not even subscribe', async () => {
    const fake = fakeMap()
    const { client } = fakeClient({ traffic: shown(aircraft('A')), layers: LAYERS_ON })
    await mount(client, fake, { live: false })
    expect(client.subscribe).not.toHaveBeenCalled()
    expect(fake.map.addSource).not.toHaveBeenCalled()
  })

  it('waits for the map to be ready', async () => {
    const fake = fakeMap()
    const { client } = fakeClient({ traffic: shown(aircraft('A')), layers: LAYERS_ON })
    await mount(client, fake, { mapReady: false })
    expect(fake.map.addSource).not.toHaveBeenCalled()
  })

  it('adds the source, the icon and the two layers once, and draws the aircraft', async () => {
    const fake = fakeMap()
    const { client } = fakeClient({
      traffic: shown(aircraft('BAW1'), aircraft('BAW2', { longitude: -2 })),
      layers: LAYERS_ON
    })
    const view = await mount(client, fake)
    expect(fake.map.addSource).toHaveBeenCalledTimes(1)
    expect([...fake.layers.keys()]).toEqual(['network-traffic-air', 'network-traffic-ground'])
    expect(lastFeatures(fake).map((f) => f.properties.callsign)).toEqual(['BAW1', 'BAW2'])
    expect(view.result.current.layers).toEqual(LAYERS_ON)
    expect(view.result.current.traffic?.state).toBe('shown')
  })

  it('draws airborne aircraft larger and bright, and ground ones smaller and dimmer, in amber', async () => {
    const fake = fakeMap()
    const { client } = fakeClient({ traffic: shown(aircraft('A')), layers: LAYERS_ON })
    await mount(client, fake)
    const air = fake.layers.get('network-traffic-air')
    const ground = fake.layers.get('network-traffic-ground')
    expect(air?.filter).toEqual(['!', ['get', 'onGround']])
    expect(ground?.filter).toEqual(['get', 'onGround'])
    expect(air?.layout['icon-size']).toBeGreaterThan(ground?.layout['icon-size'] as number)
    expect(ground?.paint['icon-opacity']).toBeLessThan(1)
    expect(air?.paint['icon-color']).toBe('#f59f00')
    expect(air?.layout['icon-rotate']).toEqual(['get', 'headingDeg'])
    expect(air?.layout['icon-allow-overlap']).toBe(true)
  })

  it('labels airborne aircraft from zoom 7 and ground ones from zoom 13', async () => {
    const fake = fakeMap()
    const { client } = fakeClient({ traffic: shown(aircraft('A')), layers: LAYERS_ON })
    await mount(client, fake)
    expect(fake.layers.get('network-traffic-air')?.layout['text-size']).toEqual(['step', ['zoom'], 0, 7, 10])
    expect(fake.layers.get('network-traffic-ground')?.layout['text-size']).toEqual([
      'step',
      ['zoom'],
      0,
      13,
      10
    ])
  })

  it('moves airborne aircraft along their heading once a second, and leaves ground ones where they are', async () => {
    const fake = fakeMap()
    const { client } = fakeClient({
      traffic: shown(
        aircraft('AIR', { headingDeg: 90 }),
        aircraft('GND', { onGround: true, groundSpeedMs: 5 })
      ),
      layers: LAYERS_ON
    })
    await mount(client, fake)
    const start = lastFeatures(fake).map((f) => f.geometry.coordinates)
    await act(async () => {
      vi.advanceTimersByTime(GLIDE_INTERVAL_MS * 5)
    })
    const later = lastFeatures(fake).map((f) => f.geometry.coordinates)
    expect(later[0]![0]).toBeGreaterThan(start[0]![0]!)
    expect(later[0]![1]).toBeCloseTo(start[0]![1]!, 3)
    expect(later[1]).toEqual(start[1])
  })

  it('times the glide from when this screen received the payload, restarting at each push', async () => {
    const fake = fakeMap()
    const { client, push } = fakeClient({ traffic: shown(aircraft('AIR')), layers: LAYERS_ON })
    await mount(client, fake)
    await act(async () => {
      vi.advanceTimersByTime(10_000)
    })
    const glided = lastFeatures(fake)[0]!.geometry.coordinates[0]!
    act(() => push('networkTraffic', shown(aircraft('AIR'))))
    expect(lastFeatures(fake)[0]!.geometry.coordinates[0]).toBeLessThan(glided)
    expect(lastFeatures(fake)[0]!.geometry.coordinates[0]).toBeCloseTo(-1, 6)
  })

  it('stops redrawing and hides the layers when main says the layer is off, and shows them again without adding them twice', async () => {
    const fake = fakeMap()
    const { client, push } = fakeClient({ traffic: shown(aircraft('A')), layers: LAYERS_ON })
    await mount(client, fake)
    act(() => push('trafficLayers', LAYERS_OFF))
    expect(fake.visibility.get('network-traffic-air')).toBe('none')
    expect(fake.visibility.get('network-traffic-ground')).toBe('none')
    const writes = fake.sources.get('network-traffic')!.setData.mock.calls.length
    await act(async () => {
      vi.advanceTimersByTime(5_000)
    })
    expect(fake.sources.get('network-traffic')!.setData.mock.calls.length).toBe(writes)
    act(() => push('trafficLayers', LAYERS_ON))
    expect(fake.visibility.get('network-traffic-air')).toBe('visible')
    expect(fake.map.addSource).toHaveBeenCalledTimes(1)
    expect(fake.map.addLayer).toHaveBeenCalledTimes(2)
  })

  it('hides the layers when the feed is unavailable', async () => {
    const fake = fakeMap()
    const { client, push } = fakeClient({ traffic: shown(aircraft('A')), layers: LAYERS_ON })
    await mount(client, fake)
    act(() => push('networkTraffic', { network: 'vatsim', state: 'unavailable', aircraft: [] }))
    expect(fake.visibility.get('network-traffic-air')).toBe('none')
  })

  it('hides the layers and keeps nothing when the sim layer is held back or the network layer is not drawing', async () => {
    const fake = fakeMap()
    const { client, push } = fakeClient({ traffic: shown(aircraft('A')), layers: LAYERS_ON })
    await mount(client, fake)
    act(() => push('trafficLayers', { ...LAYERS_ON, networkOn: true, drawNetwork: false }))
    expect(fake.visibility.get('network-traffic-air')).toBe('none')
  })

  describe('the pointer', () => {
    it.each(['network-traffic-air', 'network-traffic-ground'])(
      'becomes a pointing hand over %s and goes back when it leaves',
      async (layerId) => {
        const fake = fakeMap()
        const { client } = fakeClient({ traffic: shown(aircraft('A')), layers: LAYERS_ON })
        await mount(client, fake)
        fake.hovers.get(`mouseenter:${layerId}`)!()
        expect(fake.canvas.style.cursor).toBe('pointer')
        fake.hovers.get(`mouseleave:${layerId}`)!()
        expect(fake.canvas.style.cursor).toBe('')
      }
    )
  })

  describe('the popup', () => {
    async function clickWith(properties: Record<string, unknown>): Promise<HTMLElement> {
      const fake = fakeMap()
      const { client } = fakeClient({ traffic: shown(aircraft('A')), layers: LAYERS_ON })
      await mount(client, fake)
      fake.clicks.get('network-traffic-air')!({ features: [{ properties }], lngLat: { lng: -1, lat: 51 } })
      expect(popups).toHaveLength(1)
      return popups[0]!.content!
    }

    it('shows the callsign, the type and route, and the altitude and speed', async () => {
      const content = await clickWith({
        callsign: 'BAW123',
        aircraftIcao: 'A320',
        departure: 'EGLL',
        arrival: 'LFPG',
        onGround: false,
        altitudeM: 10_668,
        groundSpeedMs: 231.5
      })
      expect([...content.children].map((row) => row.textContent)).toEqual([
        'BAW123',
        'A320 · EGLL → LFPG',
        '35,000 ft · 450 kt'
      ])
    })

    it('says the aircraft is on the ground instead of an altitude', async () => {
      const content = await clickWith({ callsign: 'BAW1', onGround: true, altitudeM: 25, groundSpeedMs: 3 })
      expect(content.textContent).toContain('On the ground')
      expect(content.textContent).not.toContain('ft')
    })

    it('is text only: a callsign that is HTML is shown as text and creates no elements', async () => {
      const hostile = '<img src=x onerror=alert(1)><script>alert(2)</script>'
      const content = await clickWith({
        callsign: hostile,
        aircraftIcao: '<b>x</b>',
        onGround: false,
        altitudeM: 0,
        groundSpeedMs: 0
      })
      expect(content.querySelector('img, script, b')).toBeNull()
      expect(content.children[0]?.textContent).toBe(hostile)
      expect(content.innerHTML).not.toContain('<img')
    })

    it('opens nothing when the click hit no symbol', async () => {
      const fake = fakeMap()
      const { client } = fakeClient({ traffic: shown(aircraft('A')), layers: LAYERS_ON })
      await mount(client, fake)
      fake.clicks.get('network-traffic-ground')!({ features: [], lngLat: { lng: 0, lat: 0 } })
      expect(popups).toHaveLength(0)
    })
  })

  it('stops following the topics when it unmounts', async () => {
    const fake = fakeMap()
    const { client, listeners } = fakeClient({ traffic: shown(aircraft('A')), layers: LAYERS_ON })
    const view = await mount(client, fake)
    expect(listeners.size).toBe(3)
    view.unmount()
    expect(listeners.size).toBe(0)
  })

  it('carries on, drawing nothing, when the live client cannot be reached', async () => {
    const fake = fakeMap()
    const client: LiveClient = {
      get: vi.fn(() => {
        throw new Error('no preload')
      }) as never,
      subscribe: vi.fn() as never,
      command: vi.fn()
    }
    const view = await mount(client, fake)
    expect(view.result.current).toEqual({ layers: null, traffic: null, simTraffic: null })
    expect(fake.map.addSource).not.toHaveBeenCalled()
  })

  describe('the sim layer', () => {
    const SIM_LAYERS: TrafficLayers = { ...LAYERS_OFF, simOn: true, drawSim: true }
    const simShown = (...list: TrafficAircraft[]): SimTraffic => ({ state: 'shown', aircraft: list })

    it('draws the sim aircraft on its own teal source, with the same kind of symbols', async () => {
      const fake = fakeMap()
      const { client } = fakeClient({
        layers: SIM_LAYERS,
        sim: simShown(aircraft('UAL1', { key: '7' }), aircraft('DAL2', { key: '8', onGround: true }))
      })
      await mount(client, fake)
      expect(fake.sources.has('sim-traffic')).toBe(true)
      expect(fake.sources.has('network-traffic')).toBe(false)
      expect(lastFeatures(fake, 'sim-traffic').map((f) => f.properties.callsign)).toEqual(['UAL1', 'DAL2'])
      expect(fake.layers.get('sim-traffic-air')?.paint['icon-color']).toBe('#12b886')
      expect(fake.layers.get('sim-traffic-ground')?.filter).toEqual(['get', 'onGround'])
      expect(fake.visibility.get('sim-traffic-air')).toBe('visible')
    })

    it('shows nothing of the sim while the layers say the network draws', async () => {
      const fake = fakeMap()
      const { client } = fakeClient({
        layers: LAYERS_ON,
        traffic: shown(aircraft('NET1')),
        sim: simShown(aircraft('UAL1'))
      })
      await mount(client, fake)
      expect(fake.sources.has('sim-traffic')).toBe(false)
      expect(lastFeatures(fake).map((f) => f.properties.callsign)).toEqual(['NET1'])
    })

    it('hides the sim layers when the layer stops drawing, and draws again when it returns', async () => {
      const fake = fakeMap()
      const { client, push } = fakeClient({ layers: SIM_LAYERS, sim: simShown(aircraft('UAL1')) })
      await mount(client, fake)
      await act(async () => push('trafficLayers', LAYERS_OFF))
      expect(fake.visibility.get('sim-traffic-air')).toBe('none')
      expect(fake.visibility.get('sim-traffic-ground')).toBe('none')
      await act(async () => push('trafficLayers', SIM_LAYERS))
      expect(fake.visibility.get('sim-traffic-air')).toBe('visible')
    })

    it('draws nothing while the sim cannot be read, and picks up pushed aircraft', async () => {
      const fake = fakeMap()
      const { client, push } = fakeClient({
        layers: SIM_LAYERS,
        sim: { state: 'unavailable', aircraft: [] }
      })
      const view = await mount(client, fake)
      expect(fake.sources.has('sim-traffic')).toBe(false)
      expect(view.result.current.simTraffic?.state).toBe('unavailable')
      await act(async () => push('simTraffic', simShown(aircraft('UAL9'))))
      expect(lastFeatures(fake, 'sim-traffic').map((f) => f.properties.callsign)).toEqual(['UAL9'])
    })
  })

  it('carries on when a first read is rejected', async () => {
    const fake = fakeMap()
    const { client } = fakeClient({})
    ;(client.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('gone'))
    const view = await mount(client, fake)
    expect(view.result.current).toEqual({ layers: null, traffic: null, simTraffic: null })
  })
})
