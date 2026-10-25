import { describe, expect, it } from 'vitest'
import { decideTrafficLayers, type TrafficLayerInput } from './traffic-layers'

const base: TrafficLayerInput = {
  networkOn: false,
  simOn: false,
  network: null,
  ivaoVidSet: false,
  simAvailable: true
}

describe('decideTrafficLayers', () => {
  it('draws nothing with both switches off', () => {
    expect(decideTrafficLayers({ ...base, network: 'vatsim' })).toEqual({
      networkOn: false,
      simOn: false,
      drawNetwork: false,
      drawSim: false,
      simBlockedByNetwork: false
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

  it('draws the sim layer when it is on and available', () => {
    const layers = decideTrafficLayers({ ...base, simOn: true })
    expect(layers.drawSim).toBe(true)
    expect(layers.simBlockedByNetwork).toBe(false)
  })

  it('never draws the sim layer while it cannot be read', () => {
    expect(decideTrafficLayers({ ...base, simOn: true, simAvailable: false }).drawSim).toBe(false)
  })

  it('never draws both: the network layer holds the sim layer back, whatever its switch says', () => {
    const layers = decideTrafficLayers({ ...base, networkOn: true, simOn: true, network: 'vatsim' })
    expect(layers.drawNetwork).toBe(true)
    expect(layers.drawSim).toBe(false)
    expect(layers.simBlockedByNetwork).toBe(true)
  })

  it('lets the sim layer come back as it was when the network layer stops drawing', () => {
    const layers = decideTrafficLayers({ ...base, networkOn: false, simOn: true, network: 'vatsim' })
    expect(layers.drawSim).toBe(true)
    expect(layers.simBlockedByNetwork).toBe(false)
  })

  it('does not block the sim layer for an IVAO choice that draws nothing yet (no VID)', () => {
    const layers = decideTrafficLayers({ ...base, networkOn: true, simOn: true, network: 'ivao' })
    expect(layers.drawNetwork).toBe(false)
    expect(layers.drawSim).toBe(true)
  })
})
