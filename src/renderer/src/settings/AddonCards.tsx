/** Settings → 3rd party: the SimBrief credentials, GSX, GSX Remote and BeyondATC cards. */

import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { NavigraphLogo } from '../NavigraphLogo'
import { asyncHandler, runAsync } from '../report-error'
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
  return (
    <Card className="max-w-sm">
      <CardHeader>
        <CardTitle>{t('settingsView.credentials.cardTitle')}</CardTitle>
        <CardDescription>{t('settingsView.credentials.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form
          onSubmit={asyncHandler('SettingsView handleSaveSimbriefUsername', c.save)}
          className="flex items-end gap-2"
        >
          <Label className="flex flex-1 flex-col items-start gap-1.5">
            {t('settingsView.credentials.simbriefUsername')}
            <Input
              value={c.username}
              onChange={(e) => c.setUsername(e.target.value)}
              placeholder={t('settingsView.credentials.usernamePlaceholder')}
            />
          </Label>
          <Button type="submit" variant="outline" size="sm">
            {t('settingsView.credentials.save')}
          </Button>
        </form>
        {c.loggedIn ? (
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <NavigraphLogo className="size-6" />
              <Badge variant="default">{t('settingsView.credentials.loggedIn')}</Badge>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={asyncHandler('SettingsView handleLogoutOfNavigraph', c.logOut)}
              disabled={c.loggingOut}
            >
              {c.loggingOut ? t('settingsView.credentials.loggingOut') : t('settingsView.credentials.logOut')}
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="lg"
            className="h-auto w-full justify-start gap-3 py-3"
            onClick={asyncHandler('SettingsView handleLoginToNavigraph', c.logIn)}
            disabled={c.loggingIn}
          >
            <NavigraphLogo className="size-8" />
            <span className="text-sm font-medium">
              {c.loggingIn
                ? t('settingsView.credentials.loggingIn')
                : t('settingsView.credentials.logInWithNavigraph')}
            </span>
          </Button>
        )}
      </CardContent>
    </Card>
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
  return (
    <Card className="max-w-sm">
      <CardHeader>
        <CardTitle>{t('settingsView.gsx.cardTitle')}</CardTitle>
        <CardDescription>{t('settingsView.gsx.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-foreground">{t('settingsView.gsx.enabled')}</span>
          <Button
            type="button"
            size="sm"
            variant={gsx.enabled ? 'default' : 'outline'}
            onClick={asyncHandler('SettingsView handleGsxToggle', () => props.gsx.toggle(!gsx.enabled))}
          >
            {gsx.enabled ? t('settingsView.gsx.on') : t('settingsView.gsx.off')}
          </Button>
        </div>
        <Label className="flex flex-col items-start gap-1.5">
          {t('settingsView.gsx.receiptsFolder')}
          <div className="flex w-full gap-1.5">
            <Input
              type="text"
              readOnly
              value={gsx.folderPath ?? ''}
              placeholder={t('settingsView.gsx.notSet')}
              className="flex-1"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={asyncHandler('SettingsView handleGsxBrowse', props.gsx.browse)}
            >
              {t('settingsView.gsx.browse')}
            </Button>
          </div>
        </Label>
        <p className="text-xs text-muted-foreground">{t('settingsView.gsx.pathHint')}</p>
        <Label className="flex flex-col items-start gap-1.5">
          {t('settingsView.gsx.displayCurrency')}
          <Select
            value={gsx.displayCurrency}
            onValueChange={asyncHandler('SettingsView handleGsxCurrencyChange', props.gsx.setCurrency)}
          >
            <SelectTrigger className="w-full">
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
        </Label>
        <p className="text-xs text-muted-foreground">{t('settingsView.gsx.currencyHint')}</p>
      </CardContent>
    </Card>
  )
}

/**
 * A connection's state as a badge, shown while the add-on is switched on.
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
  return (
    <Badge
      variant={
        props.state === 'connected' ? 'default' : props.state === 'connecting' ? 'secondary' : 'outline'
      }
    >
      {props.state === 'connected'
        ? t(`${props.keyPrefix}.statusConnected`)
        : props.state === 'connecting'
          ? t(`${props.keyPrefix}.statusConnecting`)
          : t(`${props.keyPrefix}.statusDisconnected`)}
    </Badge>
  )
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
  return (
    <Card className="max-w-sm">
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2">
          {t('settingsView.gsxRemote.cardTitle')}
          {r.settings.enabled && (
            <ConnectionBadge state={r.status.state} keyPrefix="settingsView.gsxRemote" />
          )}
        </CardTitle>
        <CardDescription>{t('settingsView.gsxRemote.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-foreground">{t('settingsView.gsxRemote.enabled')}</span>
          <Button
            type="button"
            size="sm"
            variant={r.settings.enabled ? 'default' : 'outline'}
            onClick={asyncHandler('SettingsView handleGsxRemoteToggle', () => r.toggle(!r.settings.enabled))}
          >
            {r.settings.enabled ? t('settingsView.gsxRemote.on') : t('settingsView.gsxRemote.off')}
          </Button>
        </div>
        <Label className="flex flex-col items-start gap-1.5">
          {t('settingsView.gsxRemote.host')}
          <Input
            type="text"
            value={r.settings.host}
            onChange={asyncHandler('SettingsView handleGsxRemoteHostChange', (e) =>
              r.setHost(e.target.value)
            )}
          />
        </Label>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            runAsync('SettingsView commitGsxRemotePort', r.commitPort())
          }}
        >
          <Label className="flex flex-col items-start gap-1.5">
            {t('settingsView.gsxRemote.port')}
            <Input
              type="number"
              min={1}
              max={65535}
              value={r.portInput}
              placeholder={t('settingsView.gsxRemote.portPlaceholder')}
              onChange={(e) => r.setPortInput(e.target.value)}
              onBlur={asyncHandler('SettingsView commitGsxRemotePort', () => r.commitPort())}
            />
          </Label>
        </form>
        <p className="text-xs text-muted-foreground">{t('settingsView.gsxRemote.portHint')}</p>
      </CardContent>
    </Card>
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
  return (
    <Card className="max-w-sm">
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2">
          {t('settingsView.beyondAtc.cardTitle')}
          {b.settings.enabled && (
            <ConnectionBadge state={b.status.state} keyPrefix="settingsView.beyondAtc" />
          )}
        </CardTitle>
        <CardDescription>{t('settingsView.beyondAtc.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-foreground">{t('settingsView.beyondAtc.enabled')}</span>
          <Button
            type="button"
            size="sm"
            variant={b.settings.enabled ? 'default' : 'outline'}
            onClick={asyncHandler('SettingsView handleBeyondAtcToggle', () => b.toggle(!b.settings.enabled))}
          >
            {b.settings.enabled ? t('settingsView.beyondAtc.on') : t('settingsView.beyondAtc.off')}
          </Button>
        </div>
        <Label className="flex flex-col items-start gap-1.5">
          {t('settingsView.beyondAtc.host')}
          <Input
            type="text"
            value={b.settings.host}
            onChange={asyncHandler('SettingsView handleBeyondAtcHostChange', (e) =>
              b.setHost(e.target.value)
            )}
          />
        </Label>
        <p className="text-xs text-muted-foreground">{t('settingsView.beyondAtc.hostHint')}</p>
      </CardContent>
    </Card>
  )
}
