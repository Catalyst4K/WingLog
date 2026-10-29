import { describe, expect, it } from 'vitest'
import { decideTrafficLayers, type TrafficLayerInput } from './traffic-layers'

const base: TrafficLayerInput = {
  networkOn: false,
  simOn: false,
  network: null,
  ivaoVidSet: false,
  simOffered: true,
  atcOn: false
}

describe('decideTrafficLayers', () => {
  it('draws nothing with both switches off', () => {
    expect(decideTrafficLayers({ ...base, network: 'vatsim' })).toEqual({
      networkOn: false,
      simOn: false,
      simOffered: true,
      atcOn: false,
      drawNetwork: false,
      drawSim: false,
      drawAtc: false
    })
  })

  describe('the ATC layer', () => {
    it('draws once a network is chosen and its own switch is on, whatever the traffic switches say', () => {
      for (const [networkOn, simOn] of [
        [false, false],
        [true, false],
        [false, true]
      ]) {
        const layers = decideTrafficLayers({ ...base, network: 'vatsim', atcOn: true, networkOn, simOn })
        expect(layers).toMatchObject({ atcOn: true, drawAtc: true })
      }
    })

    it('does not draw with its switch off, however the network’s is', () => {
      const layers = decideTrafficLayers({ ...base, network: 'vatsim', networkOn: true, atcOn: false })
      expect(layers).toMatchObject({ atcOn: false, drawAtc: false, drawNetwork: true })
    })

    it('does not draw with no network chosen, but remembers that its switch is on', () => {
      expect(decideTrafficLayers({ ...base, atcOn: true })).toMatchObject({ atcOn: true, drawAtc: false })
    })

    it('needs the VID for IVAO, and not for VATSIM', () => {
      expect(decideTrafficLayers({ ...base, network: 'ivao', atcOn: true }).drawAtc).toBe(false)
      expect(decideTrafficLayers({ ...base, network: 'ivao', ivaoVidSet: true, atcOn: true }).drawAtc).toBe(
        true
      )
      expect(
        decideTrafficLayers({ ...base, network: 'vatsim', ivaoVidSet: false, atcOn: true }).drawAtc
      ).toBe(true)
    })

    it('does not depend on the sim traffic button being offered', () => {
      expect(
        decideTrafficLayers({ ...base, network: 'vatsim', atcOn: true, simOffered: false }).drawAtc
      ).toBe(true)
    })
  })

  it('draws the network layer once a network is chosen and its switch is on', () => {
    expect(decideTrafficLayers({ ...base, networkOn: true, network: 'vatsim' }).drawNetwork).toBe(true)
  })

  it('does not draw the network layer with no network chosen, even with the switch on', () => {
    const layers = decideTrafficLayers({ ...base, networkOn: true })
    expect(layers.networkOn).toBe(true)
    expect(layers.drawNetwork).toBe(false)
  })

  it('needs the VID for IVAO and not for VATSIM', () => {
    expect(decideTrafficLayers({ ...base, networkOn: true, network: 'ivao' }).drawNetwork).toBe(false)
    expect(
      decideTrafficLayers({ ...base, networkOn: true, network: 'ivao', ivaoVidSet: true }).drawNetwork
    ).toBe(true)
    expect(
      decideTrafficLayers({ ...base, networkOn: true, network: 'vatsim', ivaoVidSet: false }).drawNetwork
    ).toBe(true)
  })

  it('draws the sim layer when its switch is on', () => {
    const layers = decideTrafficLayers({ ...base, simOn: true })
    expect(layers.drawSim).toBe(true)
  })

  it('neither offers nor draws the sim layer when its button is switched off in Settings, whatever its switch says', () => {
    const layers = decideTrafficLayers({ ...base, simOn: true, simOffered: false })
    expect(layers).toMatchObject({
      simOn: true,
      simOffered: false,
      drawSim: false
    })
  })

  it('never draws both: with both switches stored on (a build from before they switched each other off), the network wins and the sim reads as off', () => {
    const layers = decideTrafficLayers({ ...base, networkOn: true, simOn: true, network: 'vatsim' })
    expect(layers).toMatchObject({ drawNetwork: true, simOn: false, drawSim: false })
  })

  it('does not block the sim layer for an IVAO choice that draws nothing yet (no VID)', () => {
    const layers = decideTrafficLayers({ ...base, networkOn: true, simOn: true, network: 'ivao' })
    expect(layers.drawNetwork).toBe(false)
    expect(layers.drawSim).toBe(true)
  })
})
