import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { NetworkTraffic, TrafficLayers } from '@shared/ipc'
import { MapControls, MapPills } from './MapOverlays'

const LAYERS_OFF: TrafficLayers = {
  networkOn: false,
  simOn: false,
  drawNetwork: false,
  drawSim: false,
  simBlockedByNetwork: false
}
const LAYERS_ON: TrafficLayers = { ...LAYERS_OFF, networkOn: true, drawNetwork: true }

function traffic(network: NetworkTraffic['network'], state: NetworkTraffic['state']): NetworkTraffic {
  return { network, state, aircraft: [] }
}

function controls(networkTraffic: Parameters<typeof MapControls>[0]['networkTraffic'], live = true): void {
  render(
    <MapControls
      live={live}
      followEnabled
      onToggleFollow={() => {}}
      vfrEnabled={false}
      onToggleVfr={() => {}}
      networkTraffic={networkTraffic}
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
    expect(screen.queryByRole('button', { name: /traffic/ })).not.toBeInTheDocument()
  })

  it('is hidden before the topics have arrived, and on a map that is not live', () => {
    controls({ layers: null, traffic: null, onToggle: () => {} })
    expect(screen.queryByRole('button', { name: /traffic/ })).not.toBeInTheDocument()
  })

  it('is not shown on a finished flight', () => {
    controls({ layers: LAYERS_OFF, traffic: traffic('vatsim', 'off'), onToggle: () => {} }, false)
    expect(screen.queryByRole('button', { name: /traffic/ })).not.toBeInTheDocument()
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
    expect(screen.getByRole('button', { name: /IVAO traffic/ })).toHaveAttribute('aria-pressed', 'false')
  })

  it('has no button when the map was given no traffic', () => {
    controls(undefined)
    expect(screen.queryByRole('button', { name: /traffic/ })).not.toBeInTheDocument()
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
