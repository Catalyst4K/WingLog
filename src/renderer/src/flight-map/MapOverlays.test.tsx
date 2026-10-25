import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { NetworkTraffic, TrafficLayers } from '@shared/ipc'
import { MapControls, MapPills } from './MapOverlays'

const LAYERS_OFF: TrafficLayers = {
  networkOn: false,
  simOn: false,
  simOffered: true,
  drawNetwork: false,
  drawSim: false,
  simBlockedByNetwork: false
}
const LAYERS_ON: TrafficLayers = { ...LAYERS_OFF, networkOn: true, drawNetwork: true }

function traffic(network: NetworkTraffic['network'], state: NetworkTraffic['state']): NetworkTraffic {
  return { network, state, aircraft: [] }
}

type TrafficProp = NonNullable<Parameters<typeof MapControls>[0]['networkTraffic']>

function controls(
  networkTraffic: (Omit<TrafficProp, 'onToggleSim'> & { onToggleSim?: () => void }) | undefined,
  live = true
): void {
  render(
    <MapControls
      live={live}
      followEnabled
      onToggleFollow={() => {}}
      vfrEnabled={false}
      onToggleVfr={() => {}}
      networkTraffic={networkTraffic && { onToggleSim: () => {}, ...networkTraffic }}
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

  it('is disabled and says why while the network layer draws, and the switch is left as it was', async () => {
    const onToggleSim = vi.fn()
    const layers = { ...LAYERS_ON, simOn: true, simBlockedByNetwork: true }
    controls({ layers, traffic: traffic('vatsim', 'shown'), onToggle: () => {}, onToggleSim })
    const button = screen.getByRole('button', { name: 'Show sim traffic' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-pressed', 'false')
    expect(button).toHaveAttribute('title', 'Off while VATSIM traffic is shown')
    await userEvent.click(button)
    expect(onToggleSim).not.toHaveBeenCalled()
  })

  it('names IVAO when IVAO is what holds it back', () => {
    const layers = { ...LAYERS_ON, simOn: true, simBlockedByNetwork: true }
    controls({ layers, traffic: traffic('ivao', 'shown'), onToggle: () => {} })
    expect(screen.getByRole('button', { name: 'Show sim traffic' })).toHaveAttribute(
      'title',
      'Off while IVAO traffic is shown'
    )
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

  it('says when it is waiting for a position', () => {
    pills(traffic('ivao', 'noCentre'))
    expect(screen.getByText('IVAO traffic: waiting for a position')).toBeInTheDocument()
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
