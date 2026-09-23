import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import type { GsxSettings, SyncStatus } from '@shared/ipc'
import i18n from './i18n'
import { SettingsView } from './SettingsView'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

// Radix Select reaches for pointer-capture/scroll APIs jsdom doesn't implement — without
// these, opening the GSX currency dropdown throws inside Radix's own event handlers (same
// polyfill DispatchView.test.tsx/FleetView.test.tsx already needed).
beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.releasePointerCapture = () => {}
  Element.prototype.scrollIntoView = () => {}
})

function makeGsx(overrides: Partial<GsxSettings> = {}): GsxSettings {
  return { enabled: false, folderPath: null, displayCurrency: 'USD', ...overrides }
}

function makeSyncStatus(overrides: Partial<SyncStatus> = {}): SyncStatus {
  return { loggedIn: false, email: null, syncing: false, lastSyncedAt: null, lastError: null, ...overrides }
}

function createWinglog(overrides: Record<string, unknown> = {}): typeof window.winglog {
  return {
    settingsGetSimbriefUsername: vi.fn().mockResolvedValue(null),
    dispatchSimbriefLoginStatus: vi.fn().mockResolvedValue(false),
    settingsGetGsx: vi.fn().mockResolvedValue(makeGsx()),
    syncStatus: vi.fn().mockResolvedValue(makeSyncStatus()),
    appGetVersion: vi.fn().mockResolvedValue('1.2.3'),
    settingsSetGsx: vi.fn().mockResolvedValue(undefined),
    gsxBrowseFolder: vi.fn().mockResolvedValue(null),
    settingsSetSimbriefUsername: vi.fn().mockResolvedValue(undefined),
    dispatchLoginSimbrief: vi.fn().mockResolvedValue(undefined),
    dispatchFetchSimbriefUsername: vi.fn().mockResolvedValue(null),
    dispatchLogoutSimbrief: vi.fn().mockResolvedValue(undefined),
    aircraftImport: vi.fn().mockResolvedValue(null),
    aircraftExport: vi.fn().mockResolvedValue(false),
    authLogin: vi.fn().mockResolvedValue(makeSyncStatus()),
    authSignup: vi.fn().mockResolvedValue(makeSyncStatus()),
    authLogout: vi.fn().mockResolvedValue(makeSyncStatus()),
    syncNow: vi.fn().mockResolvedValue(makeSyncStatus()),
    logbookImportCsv: vi.fn().mockResolvedValue(null),
    logbookImportJson: vi.fn().mockResolvedValue(null),
    logbookExport: vi.fn().mockResolvedValue(false),
    appOpenGithub: vi.fn().mockResolvedValue(undefined),
    ...overrides
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

function setWinglog(overrides: Record<string, unknown> = {}): typeof window.winglog {
  const winglog = createWinglog(overrides)
  window.winglog = winglog
  return winglog
}

beforeEach(() => {
  setWinglog()
})

afterEach(() => {
  vi.clearAllMocks()
})

function renderSettings(
  props: Partial<React.ComponentProps<typeof SettingsView>> = {}
): ReturnType<typeof render> {
  return render(
    <SettingsView
      weightUnit={props.weightUnit ?? 'kg'}
      onWeightUnitChange={props.onWeightUnitChange ?? vi.fn()}
      altitudeUnit={props.altitudeUnit ?? 'ft'}
      onAltitudeUnitChange={props.onAltitudeUnitChange ?? vi.fn()}
      windSpeedUnit={props.windSpeedUnit ?? 'kt'}
      onWindSpeedUnitChange={props.onWindSpeedUnitChange ?? vi.fn()}
      landingDistanceUnit={props.landingDistanceUnit ?? 'ft'}
      onLandingDistanceUnitChange={props.onLandingDistanceUnitChange ?? vi.fn()}
      mapLanguage={props.mapLanguage ?? 'en'}
      onMapLanguageChange={props.onMapLanguageChange ?? vi.fn()}
      appLanguage={props.appLanguage ?? 'system'}
      onAppLanguageChange={props.onAppLanguageChange ?? vi.fn()}
      theme={props.theme ?? 'system'}
      onThemeChange={props.onThemeChange ?? vi.fn()}
      resetSignal={props.resetSignal}
    />
  )
}

describe('SettingsView', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('renders its title and units in the active i18next language, not a hardcoded English string', async () => {
    await i18n.changeLanguage('de')
    renderSettings()
    expect(await screen.findByText('Einstellungen')).toBeInTheDocument()
    expect(screen.getByText('Einheiten')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Über' })).toBeInTheDocument()
  })

  it('composes a pluralized import summary toast in the active i18next language', async () => {
    await i18n.changeLanguage('de')
    setWinglog({
      aircraftImport: vi
        .fn()
        .mockResolvedValue({ imported: 2, skipped: [{ registration: 'G-DUP', reason: 'already exists' }] })
    })
    const user = userEvent.setup()
    renderSettings()
    await user.click(screen.getByRole('tab', { name: 'Daten' }))
    await user.click((await screen.findAllByRole('button', { name: 'Importieren' }))[0])

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('2 Flugzeuge importiert. 1 übersprungen: G-DUP (already exists)')
    )
  })

  describe('category tabs', () => {
    it('shows the UI category (Units, Theme) by default', async () => {
      renderSettings()
      expect(await screen.findByText('Units')).toBeInTheDocument()
      expect(screen.getByText('Theme')).toBeInTheDocument()
      expect(screen.queryByText('Credentials')).not.toBeInTheDocument()
    })

    it('marks only the selected category with a chevron, and moves it on selection', async () => {
      const user = userEvent.setup()
      renderSettings()
      const uiTab = screen.getByRole('tab', { name: 'UI' })
      const dataTab = screen.getByRole('tab', { name: 'Data' })
      expect(within(uiTab).getByTestId('settings-active-chevron')).toBeInTheDocument()
      expect(within(dataTab).queryByTestId('settings-active-chevron')).not.toBeInTheDocument()
      expect(screen.getAllByTestId('settings-active-chevron')).toHaveLength(1)
      await user.click(dataTab)
      expect(within(dataTab).getByTestId('settings-active-chevron')).toBeInTheDocument()
      expect(within(uiTab).queryByTestId('settings-active-chevron')).not.toBeInTheDocument()
    })

    it('switches to the 3rd party category', async () => {
      const user = userEvent.setup()
      renderSettings()
      await user.click(screen.getByRole('tab', { name: '3rd party' }))
      expect(await screen.findByText('Credentials')).toBeInTheDocument()
      expect(screen.getByText('GSX ground services')).toBeInTheDocument()
    })

    it('switches to the Data category', async () => {
      const user = userEvent.setup()
      renderSettings()
      await user.click(screen.getByRole('tab', { name: 'Data' }))
      expect(await screen.findByRole('region', { name: 'Fleet data' })).toBeInTheDocument()
      expect(screen.getByRole('region', { name: 'Logbook data' })).toBeInTheDocument()
    })

    it('switches to the About category', async () => {
      const user = userEvent.setup()
      renderSettings()
      await user.click(screen.getByRole('tab', { name: 'About' }))
      expect(await screen.findByText('WingLog v1.2.3')).toBeInTheDocument()
    })

    it('does not reset on the initial mount, but returns to the UI category when resetSignal is later bumped', async () => {
      const user = userEvent.setup()
      const { rerender } = render(
        <SettingsView
          weightUnit="kg"
          onWeightUnitChange={vi.fn()}
          altitudeUnit="ft"
          onAltitudeUnitChange={vi.fn()}
          windSpeedUnit="kt"
          onWindSpeedUnitChange={vi.fn()}
          landingDistanceUnit="ft"
          onLandingDistanceUnitChange={vi.fn()}
          mapLanguage="en"
          onMapLanguageChange={vi.fn()}
          appLanguage="system"
          onAppLanguageChange={vi.fn()}
          theme="system"
          onThemeChange={vi.fn()}
          resetSignal={1}
        />
      )
      await user.click(screen.getByRole('tab', { name: 'About' }))
      await screen.findByText('WingLog v1.2.3')

      rerender(
        <SettingsView
          weightUnit="kg"
          onWeightUnitChange={vi.fn()}
          altitudeUnit="ft"
          onAltitudeUnitChange={vi.fn()}
          windSpeedUnit="kt"
          onWindSpeedUnitChange={vi.fn()}
          landingDistanceUnit="ft"
          onLandingDistanceUnitChange={vi.fn()}
          mapLanguage="en"
          onMapLanguageChange={vi.fn()}
          appLanguage="system"
          onAppLanguageChange={vi.fn()}
          theme="system"
          onThemeChange={vi.fn()}
          resetSignal={2}
        />
      )
      expect(await screen.findByText('Units')).toBeInTheDocument()
    })
  })

  describe('unit and theme settings', () => {
    it('calls onWeightUnitChange with the clicked option', async () => {
      const user = userEvent.setup()
      const onWeightUnitChange = vi.fn()
      renderSettings({ weightUnit: 'kg', onWeightUnitChange })
      await user.click(screen.getByRole('button', { name: 'lb' }))
      expect(onWeightUnitChange).toHaveBeenCalledWith('lb')
    })

    it('calls onAltitudeUnitChange with the clicked option', async () => {
      const user = userEvent.setup()
      const onAltitudeUnitChange = vi.fn()
      renderSettings({ altitudeUnit: 'ft', onAltitudeUnitChange })
      await user.click(screen.getByRole('button', { name: 'Hybrid' }))
      expect(onAltitudeUnitChange).toHaveBeenCalledWith('hybrid')
    })

    it('calls onWindSpeedUnitChange with the clicked option', async () => {
      const user = userEvent.setup()
      const onWindSpeedUnitChange = vi.fn()
      renderSettings({ windSpeedUnit: 'kt', onWindSpeedUnitChange })
      await user.click(screen.getByRole('button', { name: 'm/s' }))
      expect(onWindSpeedUnitChange).toHaveBeenCalledWith('mps')
    })

    it('calls onLandingDistanceUnitChange with the clicked option', async () => {
      const user = userEvent.setup()
      const onLandingDistanceUnitChange = vi.fn()
      renderSettings({ landingDistanceUnit: 'ft', onLandingDistanceUnitChange })
      // Scoped to this row's own button group specifically — "OFP altitudes" also has a
      // "Meters" option.
      const landingRow = screen.getByRole('group', { name: 'Landing distances' })
      await user.click(within(landingRow).getByRole('button', { name: 'Meters' }))
      expect(onLandingDistanceUnitChange).toHaveBeenCalledWith('m')
    })

    it('calls onThemeChange with the clicked option', async () => {
      const user = userEvent.setup()
      const onThemeChange = vi.fn()
      renderSettings({ theme: 'system', onThemeChange })
      await user.click(screen.getByRole('button', { name: 'Dark' }))
      expect(onThemeChange).toHaveBeenCalledWith('dark')
    })

    it('keeps each unit row\'s explanation out of sight until its info button is clicked', async () => {
      const user = userEvent.setup()
      renderSettings()

      // Not shown up front (flightdeck-backend docs/plans/v1-2.md Part 4 — these five hints
      // used to be permanent paragraphs; now they're behind an info popover, one per row).
      expect(screen.queryByText(/rather than converting everything to one unit/)).not.toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: 'More info about OFP altitudes' }))
      expect(await screen.findByText(/rather than converting everything to one unit/)).toBeInTheDocument()
    })
  })

  describe('SimBrief credentials', () => {
    it('loads and saves the SimBrief username', async () => {
      const winglog = setWinglog({ settingsGetSimbriefUsername: vi.fn().mockResolvedValue('existingalias') })
      const user = userEvent.setup()
      renderSettings()
      await user.click(screen.getByRole('tab', { name: '3rd party' }))
      const input = await screen.findByPlaceholderText('Navigraph Alias')
      expect(input).toHaveValue('existingalias')

      await user.clear(input)
      await user.type(input, '  newalias  ')
      await user.click(screen.getByRole('button', { name: 'Save' }))

      expect(winglog.settingsSetSimbriefUsername).toHaveBeenCalledWith('newalias')
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith('SimBrief username saved.'))
    })

    it('shows the log-in button when logged out, and logs in without overwriting an existing username', async () => {
      const winglog = setWinglog({
        settingsGetSimbriefUsername: vi.fn().mockResolvedValue('alreadyset'),
        dispatchSimbriefLoginStatus: vi.fn().mockResolvedValue(false)
      })
      const user = userEvent.setup()
      renderSettings()
      await user.click(screen.getByRole('tab', { name: '3rd party' }))
      const loginButton = await screen.findByRole('button', { name: 'Log in with Navigraph' })

      winglog.dispatchSimbriefLoginStatus = vi.fn().mockResolvedValue(true)
      await user.click(loginButton)

      await screen.findByText('Logged in')
      expect(winglog.dispatchLoginSimbrief).toHaveBeenCalled()
      expect(winglog.dispatchFetchSimbriefUsername).not.toHaveBeenCalled()
    })

    it('logs in with a blank username but does not auto-fill anything when the fetch finds none', async () => {
      const winglog = setWinglog({
        settingsGetSimbriefUsername: vi.fn().mockResolvedValue(null),
        dispatchSimbriefLoginStatus: vi.fn().mockResolvedValue(false),
        dispatchFetchSimbriefUsername: vi.fn().mockResolvedValue(null)
      })
      const user = userEvent.setup()
      renderSettings()
      await user.click(screen.getByRole('tab', { name: '3rd party' }))
      const loginButton = await screen.findByRole('button', { name: 'Log in with Navigraph' })

      winglog.dispatchSimbriefLoginStatus = vi.fn().mockResolvedValue(true)
      await user.click(loginButton)

      await screen.findByText('Logged in')
      expect(winglog.dispatchFetchSimbriefUsername).toHaveBeenCalled()
      expect(winglog.settingsSetSimbriefUsername).not.toHaveBeenCalled()
      expect(toast.success).not.toHaveBeenCalled()
    })

    it('shows a loading label while logging in, then auto-fills a blank username on success', async () => {
      const winglog = setWinglog({ dispatchSimbriefLoginStatus: vi.fn().mockResolvedValue(false) })
      let resolveLogin: () => void = () => {}
      winglog.dispatchLoginSimbrief = vi.fn(() => new Promise<void>((resolve) => (resolveLogin = resolve)))
      winglog.dispatchFetchSimbriefUsername = vi.fn().mockResolvedValue('fetchedalias')
      const user = userEvent.setup()
      renderSettings()
      await user.click(screen.getByRole('tab', { name: '3rd party' }))
      const loginButton = await screen.findByRole('button', { name: 'Log in with Navigraph' })

      winglog.dispatchSimbriefLoginStatus = vi.fn().mockResolvedValue(true)
      const clickPromise = user.click(loginButton)
      await screen.findByText('Logging in…')
      resolveLogin()
      await clickPromise

      await waitFor(() => expect(winglog.settingsSetSimbriefUsername).toHaveBeenCalledWith('fetchedalias'))
      expect(await screen.findByDisplayValue('fetchedalias')).toBeInTheDocument()
      await waitFor(() =>
        expect(toast.success).toHaveBeenCalledWith('SimBrief username filled in automatically: fetchedalias')
      )
    })

    it('shows the logged-in badge and logs out', async () => {
      const winglog = setWinglog({ dispatchSimbriefLoginStatus: vi.fn().mockResolvedValue(true) })
      let resolveLogout: () => void = () => {}
      winglog.dispatchLogoutSimbrief = vi.fn(() => new Promise<void>((resolve) => (resolveLogout = resolve)))
      const user = userEvent.setup()
      renderSettings()
      await user.click(screen.getByRole('tab', { name: '3rd party' }))
      await screen.findByText('Logged in')

      const logoutClick = user.click(screen.getByRole('button', { name: 'Log out' }))
      await screen.findByText('Logging out…')
      resolveLogout()
      await logoutClick

      expect(await screen.findByRole('button', { name: 'Log in with Navigraph' })).toBeInTheDocument()
    })
  })

  describe('GSX ground services', () => {
    it("doesn't restate that it's off by default — the Enabled toggle already shows that", async () => {
      const user = userEvent.setup()
      renderSettings()
      await user.click(screen.getByRole('tab', { name: '3rd party' }))
      expect(await screen.findByText(/nothing is attached until this is turned on/)).toBeInTheDocument()
      expect(screen.queryByText(/off by default/i)).not.toBeInTheDocument()
    })

    it('toggles enabled on and off, persisting each change', async () => {
      const winglog = setWinglog({ settingsGetGsx: vi.fn().mockResolvedValue(makeGsx({ enabled: false })) })
      const user = userEvent.setup()
      renderSettings()
      await user.click(screen.getByRole('tab', { name: '3rd party' }))
      const toggle = await screen.findByRole('button', { name: 'Off' })

      await user.click(toggle)
      expect(await screen.findByRole('button', { name: 'On' })).toBeInTheDocument()
      expect(winglog.settingsSetGsx).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }))

      await user.click(screen.getByRole('button', { name: 'On' }))
      expect(await screen.findByRole('button', { name: 'Off' })).toBeInTheDocument()
      expect(winglog.settingsSetGsx).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }))
    })

    it('browses for a receipts folder and saves the chosen path', async () => {
      const winglog = setWinglog({ gsxBrowseFolder: vi.fn().mockResolvedValue('C:\\GSX\\Receipts') })
      const user = userEvent.setup()
      renderSettings()
      await user.click(screen.getByRole('tab', { name: '3rd party' }))
      await user.click(await screen.findByRole('button', { name: 'Browse…' }))

      expect(await screen.findByDisplayValue('C:\\GSX\\Receipts')).toBeInTheDocument()
      expect(winglog.settingsSetGsx).toHaveBeenCalledWith(expect.objectContaining({ folderPath: 'C:\\GSX\\Receipts' }))
    })

    it('leaves the folder path untouched when the browse dialog is cancelled', async () => {
      const winglog = setWinglog({ gsxBrowseFolder: vi.fn().mockResolvedValue(null) })
      const user = userEvent.setup()
      renderSettings()
      await user.click(screen.getByRole('tab', { name: '3rd party' }))
      await user.click(await screen.findByRole('button', { name: 'Browse…' }))

      expect(screen.getByPlaceholderText('Not set')).toHaveValue('')
      expect(winglog.settingsSetGsx).not.toHaveBeenCalled()
    })

    it('changes the display currency', async () => {
      const winglog = setWinglog()
      const user = userEvent.setup()
      renderSettings()
      await user.click(screen.getByRole('tab', { name: '3rd party' }))
      await user.click(await screen.findByRole('combobox'))
      await user.click(await screen.findByRole('option', { name: /GBP/ }))

      expect(winglog.settingsSetGsx).toHaveBeenCalledWith(expect.objectContaining({ displayCurrency: 'GBP' }))
    })
  })

  describe('Map language', () => {
    it('offers every language, marks the current one, and reports a change', async () => {
      const onMapLanguageChange = vi.fn()
      const user = userEvent.setup()
      renderSettings({ mapLanguage: 'en', onMapLanguageChange })

      const group = within(await screen.findByRole('group', { name: 'Map language' }))
      for (const label of ['English', 'Local', 'Deutsch', 'Español', 'Français', 'Italiano', 'Русский']) {
        expect(group.getByRole('button', { name: label })).toBeInTheDocument()
      }
      await user.click(group.getByRole('button', { name: 'Deutsch' }))
      expect(onMapLanguageChange).toHaveBeenCalledWith('de')
    })
  })

  describe('App language', () => {
    it('offers every language plus System, marks the current one, and reports a change', async () => {
      const onAppLanguageChange = vi.fn()
      const user = userEvent.setup()
      renderSettings({ appLanguage: 'system', onAppLanguageChange })

      const group = within(await screen.findByRole('group', { name: 'App language' }))
      for (const label of ['System', 'English', 'Deutsch', 'Español', 'Français', 'Italiano', 'Русский']) {
        expect(group.getByRole('button', { name: label })).toBeInTheDocument()
      }
      await user.click(group.getByRole('button', { name: 'Deutsch' }))
      expect(onAppLanguageChange).toHaveBeenCalledWith('de')
    })
  })

  describe('Data import/export', () => {
    it('imports a fleet with no skipped rows', async () => {
      setWinglog({ aircraftImport: vi.fn().mockResolvedValue({ imported: 4, skipped: [] }) })
      const user = userEvent.setup()
      renderSettings()
      await user.click(screen.getByRole('tab', { name: 'Data' }))
      await user.click((await screen.findAllByRole('button', { name: 'Import' }))[0])
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Imported 4 aircraft.'))
    })

    it('imports a fleet with skipped rows and shows the summary toast', async () => {
      setWinglog({
        aircraftImport: vi
          .fn()
          .mockResolvedValue({ imported: 2, skipped: [{ registration: 'G-DUP', reason: 'already exists' }] })
      })
      const user = userEvent.setup()
      renderSettings()
      await user.click(screen.getByRole('tab', { name: 'Data' }))
      const importButton = (await screen.findAllByRole('button', { name: 'Import' }))[0]
      await user.click(importButton)

      await waitFor(() =>
        expect(toast.success).toHaveBeenCalledWith('Imported 2 aircraft. Skipped 1: G-DUP (already exists)')
      )
    })

    it('does nothing when the import-fleet dialog is cancelled', async () => {
      setWinglog({ aircraftImport: vi.fn().mockResolvedValue(null) })
      const user = userEvent.setup()
      renderSettings()
      await user.click(screen.getByRole('tab', { name: 'Data' }))
      await user.click((await screen.findAllByRole('button', { name: 'Import' }))[0])
      expect(toast.success).not.toHaveBeenCalled()
    })

    it('shows an error toast when the fleet import throws', async () => {
      setWinglog({ aircraftImport: vi.fn().mockRejectedValue(new Error('disk full')) })
      const user = userEvent.setup()
      renderSettings()
      await user.click(screen.getByRole('tab', { name: 'Data' }))
      await user.click((await screen.findAllByRole('button', { name: 'Import' }))[0])
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('disk full'))
    })

    it('shows an error toast with the stringified value when the fleet import throws a non-Error', async () => {
      setWinglog({ aircraftImport: vi.fn().mockRejectedValue('boom') })
      const user = userEvent.setup()
      renderSettings()
      await user.click(screen.getByRole('tab', { name: 'Data' }))
      await user.click((await screen.findAllByRole('button', { name: 'Import' }))[0])
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('boom'))
    })

    it('exports the fleet', async () => {
      setWinglog({ aircraftExport: vi.fn().mockResolvedValue(true) })
      const user = userEvent.setup()
      renderSettings()
      await user.click(screen.getByRole('tab', { name: 'Data' }))
      await user.click((await screen.findAllByRole('button', { name: 'Export' }))[0])
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Fleet exported.'))
    })

    it('does not toast when the export dialog is cancelled', async () => {
      setWinglog({ aircraftExport: vi.fn().mockResolvedValue(false) })
      const user = userEvent.setup()
      renderSettings()
      await user.click(screen.getByRole('tab', { name: 'Data' }))
      await user.click((await screen.findAllByRole('button', { name: 'Export' }))[0])
      expect(toast.success).not.toHaveBeenCalled()
    })

    it('shows an error toast when the export throws', async () => {
      setWinglog({ aircraftExport: vi.fn().mockRejectedValue(new Error('permission denied')) })
      const user = userEvent.setup()
      renderSettings()
      await user.click(screen.getByRole('tab', { name: 'Data' }))
      await user.click((await screen.findAllByRole('button', { name: 'Export' }))[0])
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('permission denied'))
    })

    it('shows an error toast with the stringified value when the export throws a non-Error', async () => {
      setWinglog({ aircraftExport: vi.fn().mockRejectedValue('boom') })
      const user = userEvent.setup()
      renderSettings()
      await user.click(screen.getByRole('tab', { name: 'Data' }))
      await user.click((await screen.findAllByRole('button', { name: 'Export' }))[0])
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('boom'))
    })

    it('defaults to JSON for Fleet and CSV for Logbook, and passes the chosen format through', async () => {
      const winglog = setWinglog({
        aircraftImport: vi.fn().mockResolvedValue(null),
        aircraftExport: vi.fn().mockResolvedValue(true)
      })
      const user = userEvent.setup()
      renderSettings()
      await user.click(screen.getByRole('tab', { name: 'Data' }))
      const fleet = within(await screen.findByRole('region', { name: 'Fleet data' }))

      await user.click(fleet.getByRole('button', { name: 'Import' }))
      await waitFor(() => expect(winglog.aircraftImport).toHaveBeenLastCalledWith('json'))

      await user.click(fleet.getByRole('button', { name: 'CSV' }))
      await user.click(fleet.getByRole('button', { name: 'Import' }))
      await waitFor(() => expect(winglog.aircraftImport).toHaveBeenLastCalledWith('csv'))
      await user.click(fleet.getByRole('button', { name: 'Export' }))
      await waitFor(() => expect(winglog.aircraftExport).toHaveBeenLastCalledWith('csv'))
    })

    it('routes a Logbook import to the CSV or JSON channel by the chosen format', async () => {
      const winglog = setWinglog({
        logbookImportCsv: vi.fn().mockResolvedValue({ imported: 1, aircraftCreated: 0, skipped: [] }),
        logbookImportJson: vi.fn().mockResolvedValue({ imported: 2, aircraftCreated: 0, skipped: [] })
      })
      const user = userEvent.setup()
      renderSettings()
      await user.click(screen.getByRole('tab', { name: 'Data' }))
      const logbook = within(await screen.findByRole('region', { name: 'Logbook data' }))

      await user.click(logbook.getByRole('button', { name: 'Import' }))
      await waitFor(() => expect(winglog.logbookImportCsv).toHaveBeenCalledTimes(1))
      expect(winglog.logbookImportJson).not.toHaveBeenCalled()

      await user.click(logbook.getByRole('button', { name: 'JSON' }))
      await user.click(logbook.getByRole('button', { name: 'Import' }))
      await waitFor(() => expect(winglog.logbookImportJson).toHaveBeenCalledTimes(1))
      await waitFor(() => expect(toast.success).toHaveBeenLastCalledWith('Imported 2 flights.'))
    })

    it('exports the logbook in the chosen format, toasting only when a file was saved', async () => {
      const winglog = setWinglog({ logbookExport: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false) })
      const user = userEvent.setup()
      renderSettings()
      await user.click(screen.getByRole('tab', { name: 'Data' }))
      const logbook = within(await screen.findByRole('region', { name: 'Logbook data' }))

      await user.click(logbook.getByRole('button', { name: 'Export' }))
      await waitFor(() => expect(winglog.logbookExport).toHaveBeenLastCalledWith('csv'))
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Logbook exported.'))

      vi.mocked(toast.success).mockClear()
      await user.click(logbook.getByRole('button', { name: 'JSON' }))
      await user.click(logbook.getByRole('button', { name: 'Export' }))
      await waitFor(() => expect(winglog.logbookExport).toHaveBeenLastCalledWith('json'))
      expect(toast.success).not.toHaveBeenCalled()
    })

    it('shows a toast when a logbook export fails', async () => {
      setWinglog({ logbookExport: vi.fn().mockRejectedValue(new Error('disk full')) })
      const user = userEvent.setup()
      renderSettings()
      await user.click(screen.getByRole('tab', { name: 'Data' }))
      const logbook = within(await screen.findByRole('region', { name: 'Logbook data' }))
      await user.click(logbook.getByRole('button', { name: 'Export' }))
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('disk full'))
    })

    it('imports a logbook CSV, including newly created aircraft and skips, and shows the summary toast', async () => {
      setWinglog({
        logbookImportCsv: vi.fn().mockResolvedValue({
          imported: 3,
          aircraftCreated: 1,
          skipped: [{ label: 'BA100 2026-01-01', reason: 'duplicate' }]
        })
      })
      const user = userEvent.setup()
      renderSettings()
      await user.click(screen.getByRole('tab', { name: 'Data' }))
      await user.click((await screen.findAllByRole('button', { name: 'Import' }))[1])

      await waitFor(() =>
        expect(toast.success).toHaveBeenCalledWith(
          'Imported 3 flights (added 1 aircraft to your fleet). Skipped 1: BA100 2026-01-01 (duplicate)'
        )
      )
    })

    it('imports a logbook CSV with a single flight and no skips or new aircraft', async () => {
      setWinglog({ logbookImportCsv: vi.fn().mockResolvedValue({ imported: 1, aircraftCreated: 0, skipped: [] }) })
      const user = userEvent.setup()
      renderSettings()
      await user.click(screen.getByRole('tab', { name: 'Data' }))
      await user.click((await screen.findAllByRole('button', { name: 'Import' }))[1])
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Imported 1 flight.'))
    })

    it('does nothing when the import-logbook dialog is cancelled', async () => {
      setWinglog({ logbookImportCsv: vi.fn().mockResolvedValue(null) })
      const user = userEvent.setup()
      renderSettings()
      await user.click(screen.getByRole('tab', { name: 'Data' }))
      await user.click((await screen.findAllByRole('button', { name: 'Import' }))[1])
      expect(toast.success).not.toHaveBeenCalled()
    })

    it('shows an error toast when the logbook import throws', async () => {
      setWinglog({ logbookImportCsv: vi.fn().mockRejectedValue(new Error('bad csv')) })
      const user = userEvent.setup()
      renderSettings()
      await user.click(screen.getByRole('tab', { name: 'Data' }))
      await user.click((await screen.findAllByRole('button', { name: 'Import' }))[1])
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('bad csv'))
    })

    it('shows an error toast with the stringified value when the logbook import throws a non-Error', async () => {
      setWinglog({ logbookImportCsv: vi.fn().mockRejectedValue('boom') })
      const user = userEvent.setup()
      renderSettings()
      await user.click(screen.getByRole('tab', { name: 'Data' }))
      await user.click((await screen.findAllByRole('button', { name: 'Import' }))[1])
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('boom'))
    })
  })

  describe('Cloud sync', () => {
    it("doesn't restate that it's off by default alongside \"until you log in\"", async () => {
      const user = userEvent.setup()
      renderSettings()
      await user.click(screen.getByRole('tab', { name: 'Data' }))
      expect(await screen.findByText(/nothing leaves this device until you log in/)).toBeInTheDocument()
      expect(screen.queryByText(/off by default/i)).not.toBeInTheDocument()
    })

    it('logs in with the trimmed email and password', async () => {
      const winglog = setWinglog({
        authLogin: vi.fn().mockResolvedValue(makeSyncStatus({ loggedIn: true, email: 'pilot@example.com' }))
      })
      const user = userEvent.setup()
      renderSettings()
      await user.click(screen.getByRole('tab', { name: 'Data' }))
      await user.type(screen.getByLabelText('Email'), '  pilot@example.com  ')
      await user.type(screen.getByLabelText('Password'), 'hunter2hunter2')
      // Scoped to the form's own submit button — the mode toggle above it is also labelled
      // "Log in".
      const form = screen.getByLabelText('Email').closest('form') as HTMLFormElement
      await user.click(within(form).getByRole('button', { name: 'Log in' }))

      expect(winglog.authLogin).toHaveBeenCalledWith('pilot@example.com', 'hunter2hunter2')
      expect(await screen.findByText('pilot@example.com')).toBeInTheDocument()
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Logged in.'))
    })

    it('shows an error toast when login fails', async () => {
      setWinglog({ authLogin: vi.fn().mockRejectedValue(new Error('invalid credentials')) })
      const user = userEvent.setup()
      renderSettings()
      await user.click(screen.getByRole('tab', { name: 'Data' }))
      await user.type(screen.getByLabelText('Email'), 'pilot@example.com')
      await user.type(screen.getByLabelText('Password'), 'hunter2hunter2')
      const form = screen.getByLabelText('Email').closest('form') as HTMLFormElement
      await user.click(within(form).getByRole('button', { name: 'Log in' }))
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('invalid credentials'))
    })

    it('shows an error toast with the stringified value when login fails with a non-Error', async () => {
      setWinglog({ authLogin: vi.fn().mockRejectedValue('boom') })
      const user = userEvent.setup()
      renderSettings()
      await user.click(screen.getByRole('tab', { name: 'Data' }))
      await user.type(screen.getByLabelText('Email'), 'pilot@example.com')
      await user.type(screen.getByLabelText('Password'), 'hunter2hunter2')
      const form = screen.getByLabelText('Email').closest('form') as HTMLFormElement
      await user.click(within(form).getByRole('button', { name: 'Log in' }))
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('boom'))
    })

    it('switches to signup mode, showing the invite code field, and signs up', async () => {
      const winglog = setWinglog({
        authSignup: vi.fn().mockResolvedValue(makeSyncStatus({ loggedIn: true, email: 'new@example.com' }))
      })
      const user = userEvent.setup()
      renderSettings()
      await user.click(screen.getByRole('tab', { name: 'Data' }))
      await user.click(screen.getByRole('button', { name: 'Sign up' }))

      expect(screen.getByText('At least 12 characters.')).toBeInTheDocument()
      await user.type(screen.getByLabelText('Email'), 'new@example.com')
      await user.type(screen.getByLabelText('Password'), 'twelvecharspw')
      await user.type(screen.getByLabelText('Invite code'), 'invite-123')
      // Scoped to the form's own submit button — the mode toggle above it is also labelled
      // "Sign up" once this mode is active.
      const form = screen.getByLabelText('Email').closest('form') as HTMLFormElement
      await user.click(within(form).getByRole('button', { name: 'Sign up' }))

      expect(winglog.authSignup).toHaveBeenCalledWith('new@example.com', 'twelvecharspw', 'invite-123')
      expect(await screen.findByText('new@example.com')).toBeInTheDocument()
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Account created and logged in.'))
    })

    it('switches back to login mode, hiding the invite code field again', async () => {
      const user = userEvent.setup()
      renderSettings()
      await user.click(screen.getByRole('tab', { name: 'Data' }))
      await user.click(screen.getByRole('button', { name: 'Sign up' }))
      expect(screen.getByText('At least 12 characters.')).toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: 'Log in' }))
      expect(screen.queryByLabelText('Invite code')).not.toBeInTheDocument()
      expect(screen.queryByText('At least 12 characters.')).not.toBeInTheDocument()
    })

    it('shows an error toast when signup fails', async () => {
      setWinglog({ authSignup: vi.fn().mockRejectedValue(new Error('invite code invalid')) })
      const user = userEvent.setup()
      renderSettings()
      await user.click(screen.getByRole('tab', { name: 'Data' }))
      await user.click(screen.getByRole('button', { name: 'Sign up' }))
      await user.type(screen.getByLabelText('Email'), 'new@example.com')
      await user.type(screen.getByLabelText('Password'), 'twelvecharspw')
      await user.type(screen.getByLabelText('Invite code'), 'wrong')
      const form = screen.getByLabelText('Email').closest('form') as HTMLFormElement
      await user.click(within(form).getByRole('button', { name: 'Sign up' }))
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('invite code invalid'))
    })

    it('shows an error toast with the stringified value when signup fails with a non-Error', async () => {
      setWinglog({ authSignup: vi.fn().mockRejectedValue('boom') })
      const user = userEvent.setup()
      renderSettings()
      await user.click(screen.getByRole('tab', { name: 'Data' }))
      await user.click(screen.getByRole('button', { name: 'Sign up' }))
      await user.type(screen.getByLabelText('Email'), 'new@example.com')
      await user.type(screen.getByLabelText('Password'), 'twelvecharspw')
      await user.type(screen.getByLabelText('Invite code'), 'wrong')
      const form = screen.getByLabelText('Email').closest('form') as HTMLFormElement
      await user.click(within(form).getByRole('button', { name: 'Sign up' }))
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('boom'))
    })

    it('shows "Never synced yet" when logged in with no prior sync', async () => {
      setWinglog({
        syncStatus: vi.fn().mockResolvedValue(makeSyncStatus({ loggedIn: true, email: 'pilot@example.com' }))
      })
      renderSettings()
      const dataTab = screen.getByRole('tab', { name: 'Data' })
      await userEvent.setup().click(dataTab)
      expect(await screen.findByText('Never synced yet.')).toBeInTheDocument()
    })

    it('shows the last-synced time and any last error, and runs a manual sync', async () => {
      const winglog = setWinglog({
        syncStatus: vi.fn().mockResolvedValue(
          makeSyncStatus({
            loggedIn: true,
            email: 'pilot@example.com',
            lastSyncedAt: '2026-09-13T12:00:00.000Z',
            lastError: 'network unreachable'
          })
        )
      })
      let resolveSync: (status: SyncStatus) => void = () => {}
      winglog.syncNow = vi.fn(() => new Promise<SyncStatus>((resolve) => (resolveSync = resolve)))
      const user = userEvent.setup()
      renderSettings()
      await user.click(screen.getByRole('tab', { name: 'Data' }))

      expect(await screen.findByText('network unreachable')).toBeInTheDocument()
      expect(screen.getByText(/Last synced/)).toBeInTheDocument()

      const syncClick = user.click(screen.getByRole('button', { name: 'Sync now' }))
      await screen.findByText('Syncing…')
      resolveSync(makeSyncStatus({ loggedIn: true, email: 'pilot@example.com', lastError: null }))
      await syncClick

      await waitFor(() => expect(screen.queryByText('network unreachable')).not.toBeInTheDocument())
      expect(winglog.syncNow).toHaveBeenCalled()
    })

    it('shows an error toast when a manual sync itself reports a lastError', async () => {
      setWinglog({
        syncStatus: vi.fn().mockResolvedValue(makeSyncStatus({ loggedIn: true, email: 'pilot@example.com' })),
        syncNow: vi.fn().mockResolvedValue(makeSyncStatus({ loggedIn: true, lastError: 'sync failed' }))
      })
      const user = userEvent.setup()
      renderSettings()
      await user.click(screen.getByRole('tab', { name: 'Data' }))
      await user.click(await screen.findByRole('button', { name: 'Sync now' }))
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('sync failed'))
    })

    it('logs out', async () => {
      const winglog = setWinglog({
        syncStatus: vi.fn().mockResolvedValue(makeSyncStatus({ loggedIn: true, email: 'pilot@example.com' })),
        authLogout: vi.fn().mockResolvedValue(makeSyncStatus())
      })
      const user = userEvent.setup()
      renderSettings()
      await user.click(screen.getByRole('tab', { name: 'Data' }))
      await user.click(await screen.findByRole('button', { name: 'Log out' }))
      expect(winglog.authLogout).toHaveBeenCalled()
      expect(await screen.findByLabelText('Email')).toBeInTheDocument()
    })
  })

  describe('About', () => {
    it('shows the app version once loaded', async () => {
      setWinglog({ appGetVersion: vi.fn().mockResolvedValue('9.9.9') })
      const user = userEvent.setup()
      renderSettings()
      await user.click(screen.getByRole('tab', { name: 'About' }))
      expect(await screen.findByText('WingLog v9.9.9')).toBeInTheDocument()
    })

    it('opens the GitHub repo through the app link', async () => {
      const winglog = setWinglog()
      const user = userEvent.setup()
      renderSettings()
      await user.click(screen.getByRole('tab', { name: 'About' }))
      await user.click(await screen.findByText('github.com/Catalyst4K/WingLog'))
      expect(winglog.appOpenGithub).toHaveBeenCalled()
    })
  })
})
