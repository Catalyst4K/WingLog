import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { UpdateStatus, WingLogApi } from '@shared/ipc'
import { UpdateBanner } from './UpdateBanner'
import { UpdatesCard } from './UpdatesCard'

const AVAILABLE: UpdateStatus = {
  state: 'available',
  currentVersion: '1.3.2',
  latest: {
    version: '1.4.0',
    url: 'https://github.com/Catalyst4K/WingLog/releases/tag/v1.4.0',
    notes: '## New\n- BeyondATC integration\n<script>alert(1)</script>',
    publishedAt: '2026-10-04T18:00:00Z'
  },
  checkedAt: '2026-10-04T18:30:00Z',
  skippedVersion: null
}
const IDLE: UpdateStatus = {
  state: 'idle',
  currentVersion: '1.3.2',
  latest: null,
  checkedAt: null,
  skippedVersion: null
}

function withWinglog(
  status: UpdateStatus,
  overrides: Partial<WingLogApi> = {}
): { push: (status: UpdateStatus) => void; api: WingLogApi } {
  let listener: (status: UpdateStatus) => void = () => {}
  const api = {
    updatesGetStatus: vi.fn().mockResolvedValue(status),
    onUpdateStatus: vi.fn((l: (status: UpdateStatus) => void) => {
      listener = l
      return () => {}
    }),
    updatesOpenRelease: vi.fn().mockResolvedValue(undefined),
    updatesSkipVersion: vi.fn().mockResolvedValue(undefined),
    updatesCheckNow: vi.fn().mockResolvedValue(status),
    settingsGetUpdates: vi.fn().mockResolvedValue({ checkEnabled: true }),
    settingsSetUpdates: vi.fn().mockResolvedValue(undefined),
    ...overrides
  } as unknown as WingLogApi
  window.winglog = api
  return { push: (next) => act(() => listener(next)), api }
}

describe('UpdateBanner', () => {
  it('announces a newer release and opens its page through main, never a URL of its own', async () => {
    const { api } = withWinglog(AVAILABLE)
    const user = userEvent.setup()
    render(<UpdateBanner airborne={false} />)

    expect(await screen.findByText('WingLog 1.4.0 is available.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Download' }))
    expect(api.updatesOpenRelease).toHaveBeenCalledWith()
  })

  it('shows the release notes as plain text, not HTML', async () => {
    withWinglog(AVAILABLE)
    const user = userEvent.setup()
    const { container } = render(<UpdateBanner airborne={false} />)
    await user.click(await screen.findByRole('button', { name: "What's new" }))

    expect(screen.getByText(/BeyondATC integration/)).toHaveTextContent('<script>alert(1)</script>')
    expect(container.querySelector('script')).toBeNull()
  })

  it('"Skip this version" asks main to remember it, and the banner goes once main confirms', async () => {
    const { api, push } = withWinglog(AVAILABLE)
    const user = userEvent.setup()
    render(<UpdateBanner airborne={false} />)
    await user.click(await screen.findByRole('button', { name: 'Skip this version' }))
    expect(api.updatesSkipVersion).toHaveBeenCalledWith('1.4.0')

    push({ ...AVAILABLE, skippedVersion: '1.4.0' })
    expect(screen.queryByText('WingLog 1.4.0 is available.')).not.toBeInTheDocument()
  })

  it('dismissing hides it for this session, but a newer release still shows', async () => {
    const { push } = withWinglog(AVAILABLE)
    const user = userEvent.setup()
    render(<UpdateBanner airborne={false} />)
    await user.click(await screen.findByRole('button', { name: 'Dismiss for now' }))
    expect(screen.queryByText('WingLog 1.4.0 is available.')).not.toBeInTheDocument()

    push({ ...AVAILABLE, latest: { ...AVAILABLE.latest!, version: '1.4.1' } })
    expect(screen.getByText('WingLog 1.4.1 is available.')).toBeInTheDocument()
  })

  it('stays out of the way while airborne, and appears once on the ground', async () => {
    withWinglog(AVAILABLE)
    const { rerender } = render(<UpdateBanner airborne />)
    await waitFor(() => expect(window.winglog.updatesGetStatus).toHaveBeenCalled())
    expect(screen.queryByText('WingLog 1.4.0 is available.')).not.toBeInTheDocument()
    rerender(<UpdateBanner airborne={false} />)
    expect(await screen.findByText('WingLog 1.4.0 is available.')).toBeInTheDocument()
  })

  it('shows nothing when up to date, checking, or after a failed check', async () => {
    const { push } = withWinglog(IDLE)
    render(<UpdateBanner airborne={false} />)
    for (const state of ['checking', 'upToDate', 'error'] as const) {
      push({ ...IDLE, state })
      expect(screen.queryByRole('region', { name: 'Update available' })).not.toBeInTheDocument()
    }
  })
})

describe('UpdatesCard (Settings → About)', () => {
  it('switches the automatic check off and on, starting from on', async () => {
    const { api } = withWinglog(IDLE)
    const user = userEvent.setup()
    render(<UpdatesCard />)
    const group = await screen.findByRole('group', { name: 'Check for updates automatically' })
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'On' })).toHaveAttribute('aria-pressed', 'true')
    )
    expect(group).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Off' }))
    expect(api.settingsSetUpdates).toHaveBeenCalledWith({ checkEnabled: false })
    expect(screen.getByRole('button', { name: 'Off' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('"Check now" asks main, and shows each result', async () => {
    const { api, push } = withWinglog(IDLE)
    const user = userEvent.setup()
    render(<UpdatesCard />)
    await user.click(await screen.findByRole('button', { name: 'Check now' }))
    expect(api.updatesCheckNow).toHaveBeenCalled()

    push({ ...IDLE, state: 'checking' })
    expect(screen.getByRole('status')).toHaveTextContent('Checking…')
    expect(screen.getByRole('button', { name: 'Check now' })).toBeDisabled()
    push({ ...IDLE, state: 'upToDate' })
    expect(screen.getByRole('status')).toHaveTextContent("You're on the latest version (1.3.2).")
    push({ ...IDLE, state: 'error' })
    expect(screen.getByRole('status')).toHaveTextContent("Couldn't check for updates. Try again later.")
    push(AVAILABLE)
    expect(screen.getByRole('status')).toHaveTextContent('WingLog 1.4.0 is available.')
    await user.click(screen.getByRole('button', { name: 'Download' }))
    expect(api.updatesOpenRelease).toHaveBeenCalled()
  })
})
