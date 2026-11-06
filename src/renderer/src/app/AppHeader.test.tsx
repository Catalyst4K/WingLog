import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
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
