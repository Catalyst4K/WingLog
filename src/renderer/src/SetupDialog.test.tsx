import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { WingLogApi } from '@shared/ipc'
import { SetupDialog, type SetupDialogProps } from './SetupDialog'

function withWinglog(overrides: Partial<WingLogApi> = {}): WingLogApi {
  const api = {
    setupComplete: vi.fn().mockResolvedValue(undefined),
    setupGetContext: vi.fn().mockResolvedValue({
      gsxFolderFound: true,
      gsxFolderPath: 'C:\\Users\\pilot\\AppData\\Roaming\\Virtuali\\GSX\\Receipts',
      beyondAtcRunning: true
    }),
    settingsGetSimbriefUsername: vi.fn().mockResolvedValue(null),
    settingsSetSimbriefUsername: vi.fn().mockResolvedValue(undefined),
    settingsGetGsx: vi.fn().mockResolvedValue({ enabled: false, folderPath: null, displayCurrency: 'USD' }),
    settingsSetGsx: vi.fn().mockResolvedValue(undefined),
    settingsGetGsxRemote: vi.fn().mockResolvedValue({ enabled: false, host: 'localhost', port: 8744 }),
    settingsSetGsxRemote: vi.fn().mockResolvedValue(undefined),
    settingsGetBeyondAtc: vi.fn().mockResolvedValue({ enabled: false, host: 'localhost' }),
    settingsSetBeyondAtc: vi.fn().mockResolvedValue(undefined),
    settingsGetTracking: vi.fn().mockResolvedValue({ autoStart: true, autoFinish: true }),
    settingsSetTracking: vi.fn().mockResolvedValue(undefined),
    settingsGetUpdates: vi.fn().mockResolvedValue({ checkEnabled: true }),
    settingsSetUpdates: vi.fn().mockResolvedValue(undefined),
    ...overrides
  } as unknown as WingLogApi
  window.winglog = api
  return api
}

function props(overrides: Partial<SetupDialogProps> = {}): SetupDialogProps {
  return {
    open: true,
    onClose: vi.fn(),
    weightUnit: 'kg',
    onWeightUnitChange: vi.fn(),
    altitudeUnit: 'ft',
    onAltitudeUnitChange: vi.fn(),
    windSpeedUnit: 'kt',
    onWindSpeedUnitChange: vi.fn(),
    landingDistanceUnit: 'ft',
    onLandingDistanceUnitChange: vi.fn(),
    mapLanguage: 'en',
    onMapLanguageChange: vi.fn(),
    appLanguage: 'system',
    onAppLanguageChange: vi.fn(),
    onGsxRemoteEnabledChange: vi.fn(),
    onBeyondAtcEnabledChange: vi.fn(),
    ...overrides
  }
}

describe('SetupDialog (first-launch-setup.md)', () => {
  it('walks through every step, saving each choice through the same calls Settings uses', async () => {
    const api = withWinglog()
    const p = props()
    const user = userEvent.setup()
    render(<SetupDialog {...p} />)

    // 1. Welcome, with the simulation-only notice.
    expect(screen.getByRole('dialog', { name: 'Welcome to WingLog' })).toBeInTheDocument()
    expect(screen.getByText(/For flight simulation use only/)).toBeInTheDocument()
    expect(screen.getByText('Step 1 of 7')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Get started' }))

    // 2. SimBrief.
    await user.type(screen.getByRole('textbox', { name: 'SimBrief username' }), ' pilot123 ')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(api.settingsSetSimbriefUsername).toHaveBeenCalledWith('pilot123')
    expect(await screen.findByText('Saved.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Next' }))

    // 3. Language and units: App's own handlers, so the whole app follows.
    expect(screen.getByRole('dialog', { name: 'Language and units' })).toBeInTheDocument()
    await user.click(
      within(screen.getByRole('group', { name: 'Weights' })).getByRole('button', { name: 'lb' })
    )
    expect(p.onWeightUnitChange).toHaveBeenCalledWith('lb')
    await user.click(screen.getByRole('button', { name: 'Next' }))

    // 4. Add-ons: nothing switched on by itself, even with BeyondATC running.
    expect(await screen.findByText(/BeyondATC is running on this PC right now\./)).toBeInTheDocument()
    expect(screen.getByText(/GSX's receipts folder was found on this PC\./)).toBeInTheDocument()
    expect(api.settingsSetBeyondAtc).not.toHaveBeenCalled()
    await user.click(
      within(screen.getByRole('group', { name: 'BeyondATC' })).getByRole('button', { name: 'On' })
    )
    expect(api.settingsSetBeyondAtc).toHaveBeenCalledWith({ enabled: true, host: 'localhost' })
    expect(p.onBeyondAtcEnabledChange).toHaveBeenCalledWith(true)
    await user.click(
      within(screen.getByRole('group', { name: 'GSX ground services' })).getByRole('button', { name: 'On' })
    )
    expect(api.settingsSetGsx).toHaveBeenCalledWith({
      enabled: true,
      folderPath: 'C:\\Users\\pilot\\AppData\\Roaming\\Virtuali\\GSX\\Receipts',
      displayCurrency: 'USD'
    })
    await user.click(screen.getByRole('button', { name: 'Next' }))

    // 5. Tracking.
    await user.click(
      within(await screen.findByRole('group', { name: /finish/i })).getByRole('button', { name: 'Off' })
    )
    expect(api.settingsSetTracking).toHaveBeenCalledWith({ autoStart: true, autoFinish: false })
    await user.click(screen.getByRole('button', { name: 'Next' }))

    // 6. Updates.
    await user.click(
      within(await screen.findByRole('group', { name: 'Check for updates automatically' })).getByRole(
        'button',
        { name: 'Off' }
      )
    )
    expect(api.settingsSetUpdates).toHaveBeenCalledWith({ checkEnabled: false })
    await user.click(screen.getByRole('button', { name: 'Next' }))

    // 7. Done.
    expect(screen.getByRole('dialog', { name: "You're all set" })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Finish' }))
    expect(api.setupComplete).toHaveBeenCalled()
    expect(p.onClose).toHaveBeenCalled()
  })

  it('every step can be skipped, and Back returns to the previous one', async () => {
    const api = withWinglog()
    const user = userEvent.setup()
    render(<SetupDialog {...props()} />)
    await user.click(screen.getByRole('button', { name: 'Get started' }))
    for (let i = 0; i < 5; i++) await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByRole('dialog', { name: "You're all set" })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByRole('dialog', { name: 'Updates' })).toBeInTheDocument()
    expect(api.settingsSetSimbriefUsername).not.toHaveBeenCalled()
    expect(api.settingsSetBeyondAtc).not.toHaveBeenCalled()
  })

  it('closing at any step counts as done', async () => {
    const api = withWinglog()
    const p = props()
    const user = userEvent.setup()
    render(<SetupDialog {...p} />)
    await user.keyboard('{Escape}')
    await waitFor(() => expect(api.setupComplete).toHaveBeenCalled())
    expect(p.onClose).toHaveBeenCalled()
  })
})
