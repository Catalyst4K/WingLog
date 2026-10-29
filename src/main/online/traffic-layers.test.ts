import { describe, expect, it } from 'vitest'
import { decideTrafficLayers, type TrafficLayerInput } from './traffic-layers'

const base: TrafficLayerInput = {
  networkOn: false,
  simOn: false,
  network: null,
  ivaoVidSet: false,
  simOffered: true
}

describe('decideTrafficLayers', () => {
  it('draws nothing with both switches off', () => {
    expect(decideTrafficLayers({ ...base, network: 'vatsim' })).toEqual({
      networkOn: false,
      simOn: false,
      simOffered: true,
      drawNetwork: false,
      drawSim: false
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
