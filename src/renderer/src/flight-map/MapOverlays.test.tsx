import { describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { NetworkAtc, NetworkTraffic, TrafficLayers } from '@shared/ipc'
import { MapControls, MapPills } from './MapOverlays'

const LAYERS_OFF: TrafficLayers = {
  networkOn: false,
  simOn: false,
  simOffered: true,
  atcOn: false,
  drawNetwork: false,
  drawSim: false,
  drawAtc: false
}
const LAYERS_ON: TrafficLayers = { ...LAYERS_OFF, networkOn: true, drawNetwork: true }

function traffic(network: NetworkTraffic['network'], state: NetworkTraffic['state']): NetworkTraffic {
  return { network, state, aircraft: [] }
}

type TrafficProp = NonNullable<Parameters<typeof MapControls>[0]['networkTraffic']>

function controls(
  networkTraffic:
    | (Omit<TrafficProp, 'onToggleSim' | 'onToggleAtc' | 'atc'> & {
        onToggleSim?: () => void
        onToggleAtc?: () => void
        atc?: NetworkAtc | null
      })
    | undefined,
  live = true
): void {
  render(
    <MapControls
      live={live}
      followEnabled
      onToggleFollow={() => {}}
      vfrEnabled={false}
      onToggleVfr={() => {}}
      networkTraffic={
        networkTraffic && { onToggleSim: () => {}, onToggleAtc: () => {}, atc: null, ...networkTraffic }
      }
      taxiChartEnabled={false}
      onToggleTaxiChart={() => {}}
      onZoomIn={() => {}}
      onZoomOut={() => {}}
    />
  )
}

describe('the network traffic button', () => {
  it('is hidden while no network is chosen', () => {
    controls({ layers: LAYERS_OFF, traffic: traffic(null, 'noNetwork'), onToggle: () => {} })
    expect(screen.queryByRole('button', { name: /VATSIM|IVAO/ })).not.toBeInTheDocument()
  })

  it('is hidden before the topics have arrived, and on a map that is not live', () => {
    controls({ layers: null, traffic: null, onToggle: () => {} })
    expect(screen.queryByRole('button', { name: /VATSIM|IVAO/ })).not.toBeInTheDocument()
  })

  it('is not shown on a finished flight', () => {
    controls({ layers: LAYERS_OFF, traffic: traffic('vatsim', 'off'), onToggle: () => {} }, false)
    expect(screen.queryByRole('button', { name: /VATSIM|IVAO/ })).not.toBeInTheDocument()
  })

  it('offers to show the chosen network’s traffic while the switch is off, and sends the toggle on click', async () => {
    const onToggle = vi.fn()
    controls({ layers: LAYERS_OFF, traffic: traffic('vatsim', 'off'), onToggle })
    const button = screen.getByRole('button', { name: 'Show VATSIM traffic' })
    expect(button).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(button)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('reads as on, offering to hide, while the switch is on', () => {
    controls({ layers: LAYERS_ON, traffic: traffic('ivao', 'shown'), onToggle: () => {} })
    expect(screen.getByRole('button', { name: 'Hide IVAO traffic' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('is disabled for IVAO without a VID, with a title that says what to do', async () => {
    const onToggle = vi.fn()
    controls({ layers: LAYERS_OFF, traffic: traffic('ivao', 'needsVid'), onToggle })
    const button = screen.getByRole('button', { name: 'Show IVAO traffic' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', 'Enter your IVAO VID in Settings to see IVAO traffic')
    await userEvent.click(button)
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('does not read as on for IVAO without a VID even if the switch was left on', () => {
    controls({ layers: LAYERS_ON, traffic: traffic('ivao', 'needsVid'), onToggle: () => {} })
    expect(screen.getByRole('button', { name: 'Show IVAO traffic' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('has no button when the map was given no traffic', () => {
    controls(undefined)
    expect(screen.queryByRole('button', { name: /traffic/ })).not.toBeInTheDocument()
  })
})

describe('the sim traffic button', () => {
  it('is there with no network chosen, offers to show, and sends its own toggle on click', async () => {
    const onToggle = vi.fn()
    const onToggleSim = vi.fn()
    controls({ layers: LAYERS_OFF, traffic: traffic(null, 'noNetwork'), onToggle, onToggleSim })
    const button = screen.getByRole('button', { name: 'Show sim traffic' })
    expect(button).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(button)
    expect(onToggleSim).toHaveBeenCalledTimes(1)
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('reads as on while its switch is on and the sim layer draws', () => {
    const layers = { ...LAYERS_OFF, simOn: true, drawSim: true }
    controls({ layers, traffic: traffic('vatsim', 'off'), onToggle: () => {} })
    expect(screen.getByRole('button', { name: 'Hide sim traffic' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('reads as off and can still be pressed while the network layer draws: pressing it swaps the layers (Callum, 2026-10-29)', async () => {
    const onToggleSim = vi.fn()
    controls({ layers: LAYERS_ON, traffic: traffic('vatsim', 'shown'), onToggle: () => {}, onToggleSim })
    const button = screen.getByRole('button', { name: 'Show sim traffic' })
    expect(button).toBeEnabled()
    expect(button).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(button)
    expect(onToggleSim).toHaveBeenCalledOnce()
  })

  it('is not shown on a finished flight', () => {
    controls({ layers: LAYERS_OFF, traffic: traffic('vatsim', 'off'), onToggle: () => {} }, false)
    expect(screen.queryByRole('button', { name: /sim traffic/ })).not.toBeInTheDocument()
  })

  it.each([
    ['when switched off in Settings', { ...LAYERS_OFF, simOffered: false }],
    ['before the topics have arrived', null]
  ])('is not offered %s', (_case, layers) => {
    controls({ layers, traffic: traffic(null, 'noNetwork'), onToggle: () => {} })
    expect(screen.queryByRole('button', { name: /sim traffic/ })).not.toBeInTheDocument()
  })
})

function atc(network: NetworkAtc['network'], state: NetworkAtc['state']): NetworkAtc {
  return { network, state, areas: [], airports: [] }
}

describe('the ATC button', () => {
  const LAYERS_ATC = { ...LAYERS_OFF, atcOn: true, drawAtc: true }

  it('is hidden while no network is chosen, before the topic arrives, and on a finished flight', () => {
    controls({
      layers: LAYERS_OFF,
      traffic: traffic(null, 'noNetwork'),
      atc: atc(null, 'noNetwork'),
      onToggle: () => {}
    })
    expect(screen.queryByRole('button', { name: /ATC/ })).not.toBeInTheDocument()
    cleanup()
    controls({ layers: LAYERS_OFF, traffic: traffic('vatsim', 'off'), atc: null, onToggle: () => {} })
    expect(screen.queryByRole('button', { name: /ATC/ })).not.toBeInTheDocument()
    cleanup()
    controls(
      {
        layers: LAYERS_OFF,
        traffic: traffic('vatsim', 'off'),
        atc: atc('vatsim', 'off'),
        onToggle: () => {}
      },
      false
    )
    expect(screen.queryByRole('button', { name: /ATC/ })).not.toBeInTheDocument()
  })

  it('offers to show the chosen network’s ATC while its switch is off, and sends its own toggle on click', async () => {
    const onToggleAtc = vi.fn()
    const onToggle = vi.fn()
    controls({
      layers: LAYERS_OFF,
      traffic: traffic('vatsim', 'off'),
      atc: atc('vatsim', 'off'),
      onToggle,
      onToggleAtc
    })
    const button = screen.getByRole('button', { name: 'Show VATSIM ATC' })
    expect(button).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(button)
    expect(onToggleAtc).toHaveBeenCalledOnce()
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('reads as on, offering to hide, while its switch is on; and names IVAO for IVAO', () => {
    controls({
      layers: LAYERS_ATC,
      traffic: traffic('vatsim', 'off'),
      atc: atc('vatsim', 'shown'),
      onToggle: () => {}
    })
    expect(screen.getByRole('button', { name: 'Hide VATSIM ATC' })).toHaveAttribute('aria-pressed', 'true')
    cleanup()
    controls({
      layers: LAYERS_OFF,
      traffic: traffic('ivao', 'off'),
      atc: atc('ivao', 'off'),
      onToggle: () => {}
    })
    expect(screen.getByRole('button', { name: 'Show IVAO ATC' })).toBeInTheDocument()
  })

  it('is disabled for IVAO without a VID, with a title that says what to do, and reads as off', () => {
    controls({
      layers: LAYERS_ATC,
      traffic: traffic('ivao', 'needsVid'),
      atc: atc('ivao', 'needsVid'),
      onToggle: () => {}
    })
    const button = screen.getByRole('button', { name: 'Show IVAO ATC' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-pressed', 'false')
    expect(button).toHaveAttribute('title', 'Enter your IVAO VID in Settings to see IVAO ATC')
  })

  it('is a button of its own: pressed with traffic on, it does not read as the traffic button', () => {
    controls({
      layers: { ...LAYERS_ATC, networkOn: true, drawNetwork: true },
      traffic: traffic('vatsim', 'shown'),
      atc: atc('vatsim', 'shown'),
      onToggle: () => {}
    })
    expect(screen.getByRole('button', { name: 'Hide VATSIM traffic' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Hide VATSIM ATC' })).toBeInTheDocument()
  })
})

describe('the ATC pill', () => {
  function atcPill(
    state: NetworkAtc['state'],
    drawAtc: boolean,
    live = true,
    network: 'vatsim' | 'ivao' = 'vatsim'
  ): void {
    render(
      <MapPills
        live={live}
        telemetry={null}
        phase={undefined}
        transition={null}
        vfr={{ enabled: false, nearestText: null }}
        taxiChart={{ enabled: false, loadingIcao: null }}
        routeIsApproximate={false}
        atc={{ layers: { ...LAYERS_OFF, atcOn: true, drawAtc }, atc: atc(network, state) }}
      />
    )
  }

  it('says the ATC cannot be drawn, only while the layer draws and is unavailable', () => {
    atcPill('unavailable', true)
    expect(screen.getByText('VATSIM ATC unavailable')).toBeInTheDocument()
  })

  it('names IVAO for IVAO', () => {
    atcPill('unavailable', true, true, 'ivao')
    expect(screen.getByText('IVAO ATC unavailable')).toBeInTheDocument()
  })

  it.each([
    ['shown', true, true],
    ['off', true, true],
    ['needsVid', true, true],
    ['unavailable', false, true],
    ['unavailable', true, false]
  ] as const)('says nothing for %s with drawAtc %s and live %s', (state, drawAtc, live) => {
    atcPill(state, drawAtc, live)
    expect(screen.queryByText(/ATC unavailable/)).not.toBeInTheDocument()
  })
})

describe('the sim traffic pill', () => {
  function simPill(state: 'off' | 'shown' | 'unavailable', drawSim: boolean, live = true): void {
    render(
      <MapPills
        live={live}
        telemetry={null}
        phase={undefined}
        transition={null}
        vfr={{ enabled: false, nearestText: null }}
        taxiChart={{ enabled: false, loadingIcao: null }}
        routeIsApproximate={false}
        simTraffic={{ layers: { ...LAYERS_OFF, simOn: true, drawSim }, traffic: { state, aircraft: [] } }}
      />
    )
  }

  it('says the sim cannot be read, only while the layer draws and is unavailable', () => {
    simPill('unavailable', true)
    expect(screen.getByText('Sim traffic unavailable')).toBeInTheDocument()
  })

  it.each([
    ['shown', true, true],
    ['off', true, true],
    ['unavailable', false, true],
    ['unavailable', true, false]
  ] as const)('says nothing for %s with drawSim %s and live %s', (state, drawSim, live) => {
    simPill(state, drawSim, live)
    expect(screen.queryByText(/Sim traffic/)).not.toBeInTheDocument()
  })
})

describe('the network traffic pills', () => {
  function pills(trafficValue: NetworkTraffic | null, live = true): void {
    render(
      <MapPills
        live={live}
        telemetry={null}
        phase={undefined}
        transition={null}
        vfr={{ enabled: false, nearestText: null }}
        taxiChart={{ enabled: false, loadingIcao: null }}
        routeIsApproximate={false}
        traffic={trafficValue}
      />
    )
  }

  it('says when the feed is unavailable', () => {
    pills(traffic('vatsim', 'unavailable'))
    expect(screen.getByText('VATSIM traffic unavailable')).toBeInTheDocument()
  })

  it('stacks under the nearest-airfield pill rather than covering it', () => {
    render(
      <MapPills
        live
        telemetry={null}
        phase={undefined}
        transition={null}
        vfr={{ enabled: true, nearestText: 'EGLL 2.1 nm' }}
        taxiChart={{ enabled: false, loadingIcao: null }}
        routeIsApproximate={false}
        traffic={traffic('vatsim', 'unavailable')}
      />
    )
    const nearest = screen.getByLabelText('Nearest airfield')
    const problem = screen.getByText('VATSIM traffic unavailable')
    // One column at the top left holds both, the nearest airfield first.
    expect(problem.parentElement).toBe(nearest.parentElement)
    expect(nearest.parentElement).toHaveClass('flex-col')
    expect(nearest.parentElement?.firstElementChild).toBe(nearest)
  })

  it('says nothing while traffic is shown, off, or needs a VID', () => {
    for (const state of ['shown', 'off', 'needsVid', 'noNetwork'] as const) {
      const { unmount } = render(
        <MapPills
          live
          telemetry={null}
          phase={undefined}
          transition={null}
          vfr={{ enabled: false, nearestText: null }}
          taxiChart={{ enabled: false, loadingIcao: null }}
          routeIsApproximate={false}
          traffic={traffic('vatsim', state)}
        />
      )
      expect(screen.queryByText(/traffic/i)).not.toBeInTheDocument()
      unmount()
    }
  })

  it('says nothing on a finished flight or with no traffic topic', () => {
    pills(traffic('vatsim', 'unavailable'), false)
    expect(screen.queryByText(/traffic/i)).not.toBeInTheDocument()
  })
})
