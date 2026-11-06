import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SimConnectionStatus } from '@shared/ipc'
import { Tabs } from '@/components/ui/tabs'
import { AppHeader } from './AppHeader'

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
