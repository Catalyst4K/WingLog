/**
 * The Settings tab's state, one hook per card. SettingsView calls them all at the top, so every
 * card's settings load once when the tab opens and survive switching between its categories
 * (the category panels unmount; this state doesn't).
 */

import { winglogApi } from '../data/winglog-api'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type {
  AircraftImportSummary,
  BeyondAtcConnectionStatus,
  BeyondAtcSettings,
  DataFormat,
  GsxRemoteConnectionStatus,
  GsxRemoteSettings,
  GsxSettings,
  LogbookImportSummary,
  SyncStatus
} from '@shared/ipc'
import { runAsync } from '../report-error'

/** The SimBrief username and the Navigraph login, with their actions. */
export interface SimbriefCredentials {
  username: string
  setUsername: (username: string) => void
  loggedIn: boolean | null
  loggingIn: boolean
  loggingOut: boolean
  save: (event: React.FormEvent) => Promise<void>
  logIn: () => Promise<void>
  logOut: () => Promise<void>
}

/**
 * @returns The SimBrief credentials card's state and actions.
 */
export function useSimbriefCredentials(): SimbriefCredentials {
  const { t } = useTranslation()
  const [username, setUsername] = useState('')
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null)
  const [loggingIn, setLoggingIn] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)

  useEffect(() => {
    runAsync(
      'SettingsView settingsGetSimbriefUsername',
      winglogApi().settingsGetSimbriefUsername().then((u) => setUsername(u ?? ''))
    )
    runAsync(
      'SettingsView dispatchSimbriefLoginStatus',
      winglogApi().dispatchSimbriefLoginStatus().then(setLoggedIn)
    )
  }, [])

  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    await winglogApi().settingsSetSimbriefUsername(username.trim())
    toast.success(t('settingsView.usernameSavedToast'))
  }

  async function logIn(): Promise<void> {
    setLoggingIn(true)
    try {
      await winglogApi().dispatchLoginSimbrief()
      const nowLoggedIn = await winglogApi().dispatchSimbriefLoginStatus()
      setLoggedIn(nowLoggedIn)
      if (nowLoggedIn && !username.trim()) {
        const fetched = await winglogApi().dispatchFetchSimbriefUsername()
        if (fetched) {
          setUsername(fetched)
          await winglogApi().settingsSetSimbriefUsername(fetched)
          toast.success(t('settingsView.usernameAutoFilledToast', { username: fetched }))
        }
      }
    } finally {
      setLoggingIn(false)
    }
  }

  async function logOut(): Promise<void> {
    setLoggingOut(true)
    try {
      await winglogApi().dispatchLogoutSimbrief()
      setLoggedIn(false)
    } finally {
      setLoggingOut(false)
    }
  }

  return { username, setUsername, loggedIn, loggingIn, loggingOut, save, logIn, logOut }
}

/** The GSX receipts settings, with their actions. */
export interface GsxSettingsState {
  gsx: GsxSettings
  toggle: (enabled: boolean) => Promise<void>
  browse: () => Promise<void>
  setCurrency: (displayCurrency: string) => Promise<void>
}

/**
 * @returns The GSX card's state and actions.
 */
export function useGsxSettings(): GsxSettingsState {
  const [gsx, setGsx] = useState<GsxSettings>({ enabled: false, folderPath: null, displayCurrency: 'USD' })

  useEffect(() => {
    runAsync('SettingsView settingsGetGsx', winglogApi().settingsGetGsx().then(setGsx))
  }, [])

  async function save(next: GsxSettings): Promise<void> {
    setGsx(next)
    await winglogApi().settingsSetGsx(next)
  }

  async function browse(): Promise<void> {
    const folderPath = await winglogApi().gsxBrowseFolder()
    if (!folderPath) return
    await save({ ...gsx, folderPath })
  }

  return {
    gsx,
    toggle: (enabled) => save({ ...gsx, enabled }),
    browse,
    setCurrency: (displayCurrency) => save({ ...gsx, displayCurrency })
  }
}

/** The GSX Remote connection settings and status, with their actions. */
export interface GsxRemoteSettingsState {
  settings: GsxRemoteSettings
  status: GsxRemoteConnectionStatus
  /** The port as typed, kept apart from `settings.port` so an in-progress edit (a momentarily
   *  empty field) never round-trips through Number() and becomes 0. */
  portInput: string
  setPortInput: (value: string) => void
  toggle: (enabled: boolean) => Promise<void>
  setHost: (host: string) => Promise<void>
  commitPort: () => Promise<void>
}

/**
 * @param onEnabledChange Tells App, which shows the GSX Remote tab only while it's on.
 * @returns The GSX Remote card's state and actions.
 */
export function useGsxRemoteSettings(onEnabledChange: (enabled: boolean) => void): GsxRemoteSettingsState {
  const [settings, setSettings] = useState<GsxRemoteSettings>({
    enabled: false,
    host: 'localhost',
    port: null
  })
  const [portInput, setPortInput] = useState('')
  const [status, setStatus] = useState<GsxRemoteConnectionStatus>({ state: 'disconnected', lastError: null })

  useEffect(() => {
    runAsync(
      'SettingsView settingsGetGsxRemote',
      winglogApi().settingsGetGsxRemote().then((loaded) => {
        setSettings(loaded)
        setPortInput(loaded.port != null ? String(loaded.port) : '')
        onEnabledChange(loaded.enabled)
      })
    )
    runAsync('SettingsView gsxRemoteGetStatus', winglogApi().gsxRemoteGetStatus().then(setStatus))
  }, [onEnabledChange])

  useEffect(() => winglogApi().onGsxRemoteStatus(setStatus), [])

  async function save(next: GsxRemoteSettings): Promise<void> {
    setSettings(next)
    await winglogApi().settingsSetGsxRemote(next)
  }

  async function toggle(enabled: boolean): Promise<void> {
    const next = { ...settings, enabled }
    setSettings(next)
    onEnabledChange(enabled)
    await winglogApi().settingsSetGsxRemote(next)
  }

  async function commitPort(): Promise<void> {
    const trimmed = portInput.trim()
    const port = trimmed ? Number(trimmed) : null
    if (port !== null && (!Number.isInteger(port) || port <= 0 || port > 65535)) return
    await save({ ...settings, port })
  }

  return {
    settings,
    status,
    portInput,
    setPortInput,
    toggle,
    setHost: (host) => save({ ...settings, host }),
    commitPort
  }
}

/** The BeyondATC connection settings and status, with their actions. */
export interface BeyondAtcSettingsState {
  settings: BeyondAtcSettings
  status: BeyondAtcConnectionStatus
  toggle: (enabled: boolean) => Promise<void>
  setHost: (host: string) => Promise<void>
}

/**
 * @param onEnabledChange Tells App, which shows the BeyondATC tab only while it's on.
 * @returns The BeyondATC card's state and actions.
 */
export function useBeyondAtcSettings(onEnabledChange: (enabled: boolean) => void): BeyondAtcSettingsState {
  const [settings, setSettings] = useState<BeyondAtcSettings>({ enabled: false, host: 'localhost' })
  const [status, setStatus] = useState<BeyondAtcConnectionStatus>({ state: 'disconnected', lastError: null })

  useEffect(() => {
    runAsync(
      'SettingsView settingsGetBeyondAtc',
      winglogApi().settingsGetBeyondAtc().then((loaded) => {
        setSettings(loaded)
        onEnabledChange(loaded.enabled)
      })
    )
    runAsync('SettingsView beyondAtcGetStatus', winglogApi().beyondAtcGetStatus().then(setStatus))
  }, [onEnabledChange])

  useEffect(() => winglogApi().onBeyondAtcStatus(setStatus), [])

  async function toggle(enabled: boolean): Promise<void> {
    const next = { ...settings, enabled }
    setSettings(next)
    onEnabledChange(enabled)
    await winglogApi().settingsSetBeyondAtc(next)
  }

  async function setHost(host: string): Promise<void> {
    const next = { ...settings, host }
    setSettings(next)
    await winglogApi().settingsSetBeyondAtc(next)
  }

  return { settings, status, toggle, setHost }
}

/**
 * @param summary What an aircraft import did.
 * @param t The translation function.
 * @returns The toast text.
 */
function summarizeAircraftImport(summary: AircraftImportSummary, t: TFunction): string {
  const imported = t('settingsView.data.aircraftImported', { count: summary.imported })
  if (summary.skipped.length === 0) return imported
  const skipped = summary.skipped.map((s) => `${s.registration} (${s.reason})`).join(', ')
  return t('settingsView.data.aircraftImportedWithSkipped', {
    imported,
    count: summary.skipped.length,
    skipped
  })
}

/**
 * @param summary What a logbook import did.
 * @param t The translation function.
 * @returns The toast text.
 */
function summarizeLogbookImport(summary: LogbookImportSummary, t: TFunction): string {
  let result = t('settingsView.data.flightsImported', { count: summary.imported })
  if (summary.aircraftCreated > 0) {
    result += t('settingsView.data.aircraftAddedSuffix', { count: summary.aircraftCreated })
  }
  result += '.'
  if (summary.skipped.length > 0) {
    const skipped = summary.skipped.map((s) => `${s.label} (${s.reason})`).join(', ')
    result += ' ' + t('settingsView.data.skippedSuffix', { count: summary.skipped.length, skipped })
  }
  return result
}

/**
 * @param err What a data action threw.
 */
function toastError(err: unknown): void {
  toast.error(err instanceof Error ? err.message : String(err))
}

/** Fleet and Logbook import and export: each one's file format, and its actions. */
export interface DataTransferState {
  fleetFormat: DataFormat
  setFleetFormat: (format: DataFormat) => void
  logbookFormat: DataFormat
  setLogbookFormat: (format: DataFormat) => void
  importingAircraft: boolean
  importingLogbook: boolean
  importAircraft: () => Promise<void>
  exportAircraft: () => Promise<void>
  importLogbook: () => Promise<void>
  exportLogbook: () => Promise<void>
}

/**
 * @returns The data card's state and actions.
 */
export function useDataTransfer(): DataTransferState {
  const { t } = useTranslation()
  const [fleetFormat, setFleetFormat] = useState<DataFormat>('json')
  const [logbookFormat, setLogbookFormat] = useState<DataFormat>('csv')
  const [importingAircraft, setImportingAircraft] = useState(false)
  const [importingLogbook, setImportingLogbook] = useState(false)

  async function importAircraft(): Promise<void> {
    setImportingAircraft(true)
    try {
      const summary = await winglogApi().aircraftImport(fleetFormat)
      if (summary) toast.success(summarizeAircraftImport(summary, t))
    } catch (err) {
      toastError(err)
    } finally {
      setImportingAircraft(false)
    }
  }

  async function exportAircraft(): Promise<void> {
    try {
      const saved = await winglogApi().aircraftExport(fleetFormat)
      if (saved) toast.success(t('settingsView.data.fleetExported'))
    } catch (err) {
      toastError(err)
    }
  }

  async function importLogbook(): Promise<void> {
    setImportingLogbook(true)
    try {
      const summary =
        logbookFormat === 'csv'
          ? await winglogApi().logbookImportCsv()
          : await winglogApi().logbookImportJson()
      if (summary) toast.success(summarizeLogbookImport(summary, t))
    } catch (err) {
      toastError(err)
    } finally {
      setImportingLogbook(false)
    }
  }

  async function exportLogbook(): Promise<void> {
    try {
      const saved = await winglogApi().logbookExport(logbookFormat)
      if (saved) toast.success(t('settingsView.data.logbookExported'))
    } catch (err) {
      toastError(err)
    }
  }

  return {
    fleetFormat,
    setFleetFormat,
    logbookFormat,
    setLogbookFormat,
    importingAircraft,
    importingLogbook,
    importAircraft,
    exportAircraft,
    importLogbook,
    exportLogbook
  }
}

/** Cloud sync: the account's status, the log-in form, and the actions. */
export interface CloudSyncState {
  status: SyncStatus
  email: string
  setEmail: (email: string) => void
  password: string
  setPassword: (password: string) => void
  inviteCode: string
  setInviteCode: (code: string) => void
  mode: 'login' | 'signup'
  setMode: (mode: 'login' | 'signup') => void
  submitting: boolean
  logIn: (event: React.FormEvent) => Promise<void>
  signUp: (event: React.FormEvent) => Promise<void>
  logOut: () => Promise<void>
  syncNow: () => Promise<void>
}

/**
 * @returns The cloud sync card's state and actions.
 */
export function useCloudSync(): CloudSyncState {
  const { t } = useTranslation()
  const [status, setStatus] = useState<SyncStatus>({
    loggedIn: false,
    email: null,
    syncing: false,
    lastSyncedAt: null,
    lastError: null
  })
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    // Cloud sync build-time flag (docs/plans/public-release-v1.md) — the syncStatus channel
    // doesn't exist at all in a public build, so calling it would just reject.
    /* v8 ignore start -- vitest.config.ts's `define` fixes this flag at `true` for the whole
     * test run (a single run can't hold both literal build values at once), so the "public
     * build, skip this call" arm can't be exercised here; the real cloud-sync-disabled
     * behavior is what public-release-v1.md's own build verifies, not a unit test's job. */
    if (__WINGLOG_CLOUD_SYNC_ENABLED__)
      runAsync('SettingsView syncStatus', winglogApi().syncStatus().then(setStatus))
    /* v8 ignore stop */
  }, [])

  async function logIn(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    setSubmitting(true)
    try {
      setStatus(await winglogApi().authLogin(email.trim(), password))
      setPassword('')
      toast.success(t('settingsView.cloudSync.loggedInToast'))
    } catch (err) {
      toastError(err)
    } finally {
      setSubmitting(false)
    }
  }

  async function signUp(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    setSubmitting(true)
    try {
      setStatus(await winglogApi().authSignup(email.trim(), password, inviteCode))
      setPassword('')
      setInviteCode('')
      toast.success(t('settingsView.cloudSync.accountCreatedToast'))
    } catch (err) {
      toastError(err)
    } finally {
      setSubmitting(false)
    }
  }

  async function logOut(): Promise<void> {
    setStatus(await winglogApi().authLogout())
  }

  async function syncNow(): Promise<void> {
    setStatus((current) => ({ ...current, syncing: true }))
    const next = await winglogApi().syncNow()
    setStatus(next)
    if (next.lastError) toast.error(next.lastError)
    else toast.success(t('settingsView.cloudSync.syncedToast'))
  }

  return {
    status,
    email,
    setEmail,
    password,
    setPassword,
    inviteCode,
    setInviteCode,
    mode,
    setMode,
    submitting,
    logIn,
    signUp,
    logOut,
    syncNow
  }
}
