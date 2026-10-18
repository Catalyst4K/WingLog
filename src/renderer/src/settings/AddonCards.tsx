/** Settings → 3rd party: the SimBrief credentials, GSX, GSX Remote and BeyondATC cards. */

import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { NavigraphLogo } from '../NavigraphLogo'
import { asyncHandler, runAsync } from '../report-error'
import { OnOffControl, SettingRow, SettingsCard, StatusBadge } from './ui/SettingsCard'
import type {
  BeyondAtcSettingsState,
  GsxRemoteSettingsState,
  GsxSettingsState,
  SimbriefCredentials
} from './use-settings-state'

// A curated, common-currency subset of what frankfurter.dev supports — enough for
// "I want to see this in my own currency" without a second fetch just to populate a
// dropdown (the currency list itself barely ever changes).
/**
 * @param t The translation function.
 * @returns The display currencies offered.
 */
function displayCurrencyOptions(t: TFunction): { code: string; label: string }[] {
  return [
    { code: 'USD', label: t('settingsView.currencyOptions.usd') },
    { code: 'GBP', label: t('settingsView.currencyOptions.gbp') },
    { code: 'EUR', label: t('settingsView.currencyOptions.eur') },
    { code: 'CAD', label: t('settingsView.currencyOptions.cad') },
    { code: 'AUD', label: t('settingsView.currencyOptions.aud') },
    { code: 'NZD', label: t('settingsView.currencyOptions.nzd') },
    { code: 'JPY', label: t('settingsView.currencyOptions.jpy') },
    { code: 'CHF', label: t('settingsView.currencyOptions.chf') }
  ]
}

/**
 * The SimBrief username and the Navigraph login.
 *
 * @param props The credentials' state and actions.
 * @returns The element.
 */
export function CredentialsCard(props: { credentials: SimbriefCredentials }): React.JSX.Element {
  const { t } = useTranslation()
  const c = props.credentials
  const usernameId = useId()
  return (
    <SettingsCard
      title={t('settingsView.credentials.cardTitle')}
      description={t('settingsView.credentials.description')}
    >
      <SettingRow label={t('settingsView.credentials.simbriefUsername')} controlId={usernameId}>
        <form
          onSubmit={asyncHandler('SettingsView handleSaveSimbriefUsername', c.save)}
          className="flex items-center gap-2"
        >
          <Input
            id={usernameId}
            className="w-56"
            value={c.username}
            onChange={(e) => c.setUsername(e.target.value)}
            placeholder={t('settingsView.credentials.usernamePlaceholder')}
          />
          <Button type="submit" variant="outline" size="sm">
            {t('settingsView.credentials.save')}
          </Button>
        </form>
      </SettingRow>
      <SettingRow label="Navigraph">
        {c.loggedIn ? (
          <>
            <NavigraphLogo className="size-6" />
            <StatusBadge state="connected" label={t('settingsView.credentials.loggedIn')} />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={asyncHandler('SettingsView handleLogoutOfNavigraph', c.logOut)}
              disabled={c.loggingOut}
            >
              {c.loggingOut ? t('settingsView.credentials.loggingOut') : t('settingsView.credentials.logOut')}
            </Button>
          </>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={asyncHandler('SettingsView handleLoginToNavigraph', c.logIn)}
            disabled={c.loggingIn}
          >
            <NavigraphLogo className="size-4" />
            {c.loggingIn
              ? t('settingsView.credentials.loggingIn')
              : t('settingsView.credentials.logInWithNavigraph')}
          </Button>
        )}
      </SettingRow>
    </SettingsCard>
  )
}

/**
 * The GSX receipts folder, the switch, and the display currency.
 *
 * @param props The GSX settings' state and actions.
 * @returns The element.
 */
export function GsxCard(props: { gsx: GsxSettingsState }): React.JSX.Element {
  const { t } = useTranslation()
  const { gsx } = props.gsx
  const folderId = useId()
  const currencyId = useId()
  return (
    <SettingsCard title={t('settingsView.gsx.cardTitle')} description={t('settingsView.gsx.description')}>
      <SettingRow label={t('settingsView.gsx.enabled')}>
        <OnOffControl
          label={t('settingsView.gsx.enabled')}
          enabled={gsx.enabled}
          onText={t('settingsView.gsx.on')}
          offText={t('settingsView.gsx.off')}
          onChange={asyncHandler('SettingsView handleGsxToggle', props.gsx.toggle)}
        />
      </SettingRow>
      <SettingRow
        label={t('settingsView.gsx.receiptsFolder')}
        note={t('settingsView.gsx.pathHint')}
        controlId={folderId}
        stacked
      >
        <Input
          id={folderId}
          type="text"
          readOnly
          value={gsx.folderPath ?? ''}
          placeholder={t('settingsView.gsx.notSet')}
          className="min-w-0 flex-1"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={asyncHandler('SettingsView handleGsxBrowse', props.gsx.browse)}
        >
          {t('settingsView.gsx.browse')}
        </Button>
      </SettingRow>
      <SettingRow
        label={t('settingsView.gsx.displayCurrency')}
        note={t('settingsView.gsx.currencyHint')}
        controlId={currencyId}
      >
        <Select
          value={gsx.displayCurrency}
          onValueChange={asyncHandler('SettingsView handleGsxCurrencyChange', props.gsx.setCurrency)}
        >
          <SelectTrigger id={currencyId} className="w-64 max-w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {displayCurrencyOptions(t).map((c) => (
              <SelectItem key={c.code} value={c.code}>
                {c.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>
    </SettingsCard>
  )
}

/** The text key for each connection state, under a card's translation key prefix. */
const CONNECTION_KEY = {
  connected: 'statusConnected',
  connecting: 'statusConnecting',
  disconnected: 'statusDisconnected'
} as const

/**
 * A connection's state as the card's header badge, shown while the add-on is switched on.
 *
 * @param props The connection state, and the card's translation key prefix
 *   ('settingsView.gsxRemote' or 'settingsView.beyondAtc').
 * @returns The badge.
 */
function ConnectionBadge(props: {
  state: 'disconnected' | 'connecting' | 'connected'
  keyPrefix: string
}): React.JSX.Element {
  const { t } = useTranslation()
  return <StatusBadge state={props.state} label={t(`${props.keyPrefix}.${CONNECTION_KEY[props.state]}`)} />
}

/**
 * GSX Remote's switch, host and port, and its connection state.
 *
 * @param props The GSX Remote settings' state and actions.
 * @returns The element.
 */
export function GsxRemoteCard(props: { gsxRemote: GsxRemoteSettingsState }): React.JSX.Element {
  const { t } = useTranslation()
  const r = props.gsxRemote
  const hostId = useId()
  const portId = useId()
  return (
    <SettingsCard
      title={t('settingsView.gsxRemote.cardTitle')}
      status={
        r.settings.enabled && <ConnectionBadge state={r.status.state} keyPrefix="settingsView.gsxRemote" />
      }
      description={t('settingsView.gsxRemote.description')}
    >
      <SettingRow label={t('settingsView.gsxRemote.enabled')}>
        <OnOffControl
          label={t('settingsView.gsxRemote.enabled')}
          enabled={r.settings.enabled}
          onText={t('settingsView.gsxRemote.on')}
          offText={t('settingsView.gsxRemote.off')}
          onChange={asyncHandler('SettingsView handleGsxRemoteToggle', r.toggle)}
        />
      </SettingRow>
      <SettingRow label={t('settingsView.gsxRemote.host')} controlId={hostId}>
        <Input
          id={hostId}
          type="text"
          className="w-56"
          value={r.settings.host}
          onChange={asyncHandler('SettingsView handleGsxRemoteHostChange', (e) => r.setHost(e.target.value))}
        />
      </SettingRow>
      <SettingRow
        label={t('settingsView.gsxRemote.port')}
        note={t('settingsView.gsxRemote.portHint')}
        controlId={portId}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault()
            runAsync('SettingsView commitGsxRemotePort', r.commitPort())
          }}
        >
          <Input
            id={portId}
            type="number"
            min={1}
            max={65535}
            className="w-24"
            value={r.portInput}
            placeholder={t('settingsView.gsxRemote.portPlaceholder')}
            onChange={(e) => r.setPortInput(e.target.value)}
            onBlur={asyncHandler('SettingsView commitGsxRemotePort', () => r.commitPort())}
          />
        </form>
      </SettingRow>
    </SettingsCard>
  )
}

/**
 * BeyondATC's switch and host, and its connection state.
 *
 * @param props The BeyondATC settings' state and actions.
 * @returns The element.
 */
export function BeyondAtcCard(props: { beyondAtc: BeyondAtcSettingsState }): React.JSX.Element {
  const { t } = useTranslation()
  const b = props.beyondAtc
  const hostId = useId()
  return (
    <SettingsCard
      title={t('settingsView.beyondAtc.cardTitle')}
      status={
        b.settings.enabled && <ConnectionBadge state={b.status.state} keyPrefix="settingsView.beyondAtc" />
      }
      description={t('settingsView.beyondAtc.description')}
    >
      <SettingRow label={t('settingsView.beyondAtc.enabled')}>
        <OnOffControl
          label={t('settingsView.beyondAtc.enabled')}
          enabled={b.settings.enabled}
          onText={t('settingsView.beyondAtc.on')}
          offText={t('settingsView.beyondAtc.off')}
          onChange={asyncHandler('SettingsView handleBeyondAtcToggle', b.toggle)}
        />
      </SettingRow>
      <SettingRow
        label={t('settingsView.beyondAtc.host')}
        note={t('settingsView.beyondAtc.hostHint')}
        controlId={hostId}
      >
        <Input
          id={hostId}
          type="text"
          className="w-56"
          value={b.settings.host}
          onChange={asyncHandler('SettingsView handleBeyondAtcHostChange', (e) => b.setHost(e.target.value))}
        />
      </SettingRow>
    </SettingsCard>
  )
}
