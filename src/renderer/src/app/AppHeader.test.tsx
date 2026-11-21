import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppCapabilities, HostLinkStatus, SimConnectionStatus } from '@shared/ipc'
import { Tabs } from '@/components/ui/tabs'
import { AppHeader } from './AppHeader'
import { CapabilitiesProvider } from './capabilities'

function renderHeader(simStatus: SimConnectionStatus, extra: { gsx?: boolean; beyondAtc?: boolean } = {}) {
  const onTabClick = vi.fn()
  const view = render(
    <Tabs value="track">
      <AppHeader
        gsxRemoteEnabled={extra.gsx ?? false}
        beyondAtcEnabled={extra.beyondAtc ?? false}
        onTabClick={onTabClick}
        simStatus={simStatus}
      />
    </Tabs>
  )
  return { ...view, onTabClick }
}

describe('AppHeader', () => {
  it('shows text-only tabs: no icon on any of them, and the optional ones only when turned on', () => {
    const { container, rerender } = renderHeader({ state: 'disconnected' })
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Fleet', 'Dispatch', 'Track', 'Logbook', 'Settings'])
    expect(container.querySelectorAll('[role="tab"] svg')).toHaveLength(0)
    rerender(
      <Tabs value="track">
        <AppHeader
          gsxRemoteEnabled
          beyondAtcEnabled
          onTabClick={vi.fn()}
          simStatus={{ state: 'disconnected' }}
        />
      </Tabs>
    )
    expect(screen.getAllByRole('tab')).toHaveLength(7)
  })

  it('names the page a tab opens when it is clicked', () => {
    const { onTabClick } = renderHeader({ state: 'disconnected' })
    screen.getByRole('tab', { name: 'Logbook' }).click()
    expect(onTabClick).toHaveBeenCalledWith('logbook')
  })

  it.each([
    [{ state: 'connected', simConnectVersion: '12.2' } as const, 'green'],
    [{ state: 'connecting' } as const, 'amber'],
    [{ state: 'disconnected' } as const, 'red']
  ])('shows the sim connection (%j) as three %s lights', (status, light) => {
    const { container } = renderHeader(status)
    const lights = container.querySelector('header [data-slot="status-light"]')
    expect(lights).toHaveAttribute('data-state', light)
    expect(lights?.children).toHaveLength(3)
  })

  it('writes a lost connection in the can’t-undo red, and a live one quietly', () => {
    const lost = renderHeader({ state: 'disconnected' })
    expect(lost.container.querySelector('header [data-slot="status-light"]')?.parentElement).toHaveClass(
      'text-destructive'
    )
    lost.unmount()
    const live = renderHeader({ state: 'connected', simConnectVersion: '12.2' })
    expect(live.container.querySelector('header [data-slot="status-light"]')?.parentElement).toHaveClass(
      'text-muted-foreground'
    )
  })
})

describe('AppHeader on a client', () => {
  const CLIENT: AppCapabilities = { runMode: 'client', canHostSim: false, multiDevice: true }

  function linkStatus(
    state: HostLinkStatus['state'],
    hostSim: HostLinkStatus['hostSim'] = null
  ): HostLinkStatus {
    return {
      state,
      address: state === 'unpaired' ? null : '192.168.1.20:5051',
      hostSim,
      sync: { state: 'idle', lastSyncedAt: null, problem: null }
    }
  }

  /** Renders the header on a client whose link starts as `link`; `push` is the main process pushing a new link status. */
  function renderClient(link: HostLinkStatus) {
    let listener: (status: HostLinkStatus) => void = () => {}
    window.winglog = {
      appGetCapabilities: vi.fn(() => Promise.resolve(CLIENT)),
      hostLinkGetStatus: vi.fn(() => Promise.resolve(link)),
      onHostLinkStatus: vi.fn((next: (status: HostLinkStatus) => void) => {
        listener = next
        return () => {}
      }),
      appLogRendererError: vi.fn(() => Promise.resolve())
    } as unknown as typeof window.winglog
    // The header's own simStatus prop is the local sim's, which a client does not have: it says disconnected throughout.
    const view = render(
      <CapabilitiesProvider>
        <Tabs value="track">
          <AppHeader
            gsxRemoteEnabled={false}
            beyondAtcEnabled={false}
            onTabClick={vi.fn()}
            simStatus={{ state: 'disconnected' }}
          />
        </Tabs>
      </CapabilitiesProvider>
    )
    return { ...view, push: (status: HostLinkStatus) => act(() => listener(status)) }
  }

  const lightState = (container: HTMLElement): string | null =>
    container.querySelector('header [data-slot="status-light"]')?.getAttribute('data-state') ?? null

  it.each([
    ['connecting', 'connecting'],
    ['offline', 'not reachable'],
    ['wrong-code', 'not paired'],
    ['pair-again', 'pair again'],
    ['certificate-changed', 'certificate changed'],
    ['not-secure', 'not encrypted']
  ] as const)(
    'is red while the link is %s, and its tooltip and screen-reader text keep the reason',
    async (state, word) => {
      const { container } = renderClient(linkStatus(state, 'connected'))
      const reason = await screen.findByText(`Sim PC: ${word}`)
      await vi.waitFor(() => expect(lightState(container)).toBe('red'))
      expect(reason.parentElement).toHaveAttribute('title', `Sim PC: ${word}`)
      // The sim's own lights are not drawn: the sim is on another computer.
      expect(screen.queryByText(/^Sim: /)).not.toBeInTheDocument()
    }
  )

  it('is amber when connected to the sim PC while its sim is not, and green once the sim connects', async () => {
    const { container, push } = renderClient(linkStatus('connected', 'disconnected'))
    const noSim = "Connected to the sim PC; its sim isn't running"
    expect(await screen.findByText(noSim)).toBeInTheDocument()
    await vi.waitFor(() => expect(lightState(container)).toBe('amber'))
    expect(screen.getByText(noSim).parentElement).toHaveAttribute('title', noSim)

    push(linkStatus('connected', 'connecting'))
    expect(lightState(container)).toBe('amber')

    push(linkStatus('connected', 'connected'))
    const ready = await screen.findByText('Connected to the sim PC and its sim')
    expect(lightState(container)).toBe('green')
    expect(ready.parentElement).toHaveAttribute('title', 'Connected to the sim PC and its sim')
  })

  it('is amber, not green, while the sim PC has not yet said what its sim is doing', async () => {
    const { container } = renderClient(linkStatus('connected', null))
    await vi.waitFor(() => expect(lightState(container)).toBe('amber'))
  })

  it('is off when no sim PC has been paired', async () => {
    const { container } = renderClient(linkStatus('unpaired'))
    expect(await screen.findByText('No sim PC paired')).toBeInTheDocument()
    await vi.waitFor(() => expect(lightState(container)).toBe('off'))
  })

  it('goes red when the link drops, whatever the last sim state was', async () => {
    const { container, push } = renderClient(linkStatus('connected', 'connected'))
    await vi.waitFor(() => expect(lightState(container)).toBe('green'))
    push(linkStatus('offline', 'connected'))
    expect(lightState(container)).toBe('red')
    expect(await screen.findByText('Sim PC: not reachable')).toBeInTheDocument()
  })

  it('writes the word Sim PC beside the lights', async () => {
    renderClient(linkStatus('connected'))
    expect(await screen.findByText('Sim PC', { selector: '[aria-hidden="true"]' })).toBeInTheDocument()
  })
})

describe('AppHeader in a narrow window', () => {
  afterEach(() => vi.unstubAllGlobals())
  const narrow = (): void => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }))
    )
  }

  it('keeps Fleet, Dispatch, Track and Logbook in the bar and folds the rest behind More', async () => {
    narrow()
    renderHeader({ state: 'disconnected' }, { gsx: true, beyondAtc: true })
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Fleet',
      'Dispatch',
      'Track',
      'Logbook'
    ])
    await userEvent.click(screen.getByRole('button', { name: 'More' }))
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(
      expect.arrayContaining(['Ground services', 'BeyondATC', 'Settings'])
    )
  })

  it('opens the page picked from More, and closes the list', async () => {
    narrow()
    const { onTabClick } = renderHeader({ state: 'disconnected' })
    await userEvent.click(screen.getByRole('button', { name: 'More' }))
    await userEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(onTabClick).toHaveBeenCalledWith('settings')
    expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument()
  })

  it('names the folded page you are on, so the bar still says where you are', () => {
    narrow()
    const onTabClick = vi.fn()
    render(
      <Tabs value="settings">
        <AppHeader
          gsxRemoteEnabled={false}
          beyondAtcEnabled={false}
          onTabClick={onTabClick}
          current="settings"
          simStatus={{ state: 'disconnected' }}
        />
      </Tabs>
    )
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'More' })).not.toBeInTheDocument()
  })

  it('shows every tab, and no More, in a wide window', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }))
    )
    renderHeader({ state: 'disconnected' })
    expect(screen.getAllByRole('tab')).toHaveLength(5)
    expect(screen.queryByRole('button', { name: 'More' })).not.toBeInTheDocument()
  })
})
