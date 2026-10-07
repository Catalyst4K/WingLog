/** The first-launch setup dialog. */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  BeyondAtcSettings,
  GsxRemoteSettings,
  GsxSettings,
  SetupContext,
  UpdateSettings
} from '@shared/ipc'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { SegmentedRow, TrackingFields, UnitsFields, type UnitsFieldsProps } from './SettingsFields'
import { asyncHandler, runAsync } from './report-error'

/**
 * The first-launch setup (winglog-backend's docs/plans/first-launch-setup.md; Callum,
 * 2026-10-02: GSX and BeyondATC were hidden behind Settings, so a new user never found out
 * they existed). Every step can be skipped, closing at any point counts as done, and it can
 * be reopened from Settings → About. It uses the same controls and IPC as Settings.
 */
const STEPS = ['welcome', 'simbrief', 'units', 'addons', 'tracking', 'updates', 'done'] as const
type Step = (typeof STEPS)[number]

export interface SetupDialogProps extends UnitsFieldsProps {
  open: boolean
  onClose: () => void
  onGsxRemoteEnabledChange: (enabled: boolean) => void
  onBeyondAtcEnabledChange: (enabled: boolean) => void
}

/**
 * The setup's steps, one at a time (see STEPS).
 *
 * @param props Whether it's open, the close handler, and the settings it edits.
 * @returns The element.
 */
export function SetupDialog(props: SetupDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  const [index, setIndex] = useState(0)
  const step: Step = STEPS[index]!

  function close(): void {
    runAsync('SetupDialog setupComplete', window.winglog.setupComplete())
    setIndex(0)
    props.onClose()
  }

  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t(`setup.${step}.title`)}</DialogTitle>
          <DialogDescription>
            {t('setup.progress', { step: String(index + 1), total: String(STEPS.length) })}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {step === 'welcome' && <WelcomeStep />}
          {step === 'simbrief' && <SimbriefStep />}
          {step === 'units' && <UnitsFields {...props} />}
          {step === 'addons' && (
            <AddonsStep
              onGsxRemoteEnabledChange={props.onGsxRemoteEnabledChange}
              onBeyondAtcEnabledChange={props.onBeyondAtcEnabledChange}
            />
          )}
          {step === 'tracking' && (
            <>
              <p className="text-sm text-muted-foreground">{t('setup.tracking.intro')}</p>
              <TrackingFields />
            </>
          )}
          {step === 'updates' && <UpdatesStep />}
          {step === 'done' && <p className="text-sm text-muted-foreground">{t('setup.done.body')}</p>}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <Button type="button" variant="ghost" disabled={index === 0} onClick={() => setIndex(index - 1)}>
            {t('setup.back')}
          </Button>
          {step === 'done' ? (
            <Button type="button" onClick={close}>
              {t('setup.finish')}
            </Button>
          ) : (
            <Button type="button" onClick={() => setIndex(index + 1)}>
              {step === 'welcome' ? t('setup.start') : t('setup.next')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function WelcomeStep(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <>
      <p className="text-sm text-foreground">{t('setup.welcome.body')}</p>
      <p className="rounded-md border border-border bg-muted/50 p-3 text-sm font-medium text-foreground">
        {t('settingsView.about.simulationOnly')}
      </p>
      <p className="text-xs text-muted-foreground">{t('setup.welcome.skipHint')}</p>
    </>
  )
}

function SimbriefStep(): React.JSX.Element {
  const { t } = useTranslation()
  const [username, setUsername] = useState('')
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    runAsync(
      'SetupDialog settingsGetSimbriefUsername',
      window.winglog.settingsGetSimbriefUsername().then((value) => setUsername(value ?? ''))
    )
  }, [])

  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    await window.winglog.settingsSetSimbriefUsername(username.trim())
    setSaved(true)
  }

  return (
    <form className="flex flex-col gap-2" onSubmit={asyncHandler('SetupDialog save SimBrief username', save)}>
      <p className="text-sm text-muted-foreground">{t('setup.simbrief.body')}</p>
      <div className="flex gap-2">
        <Input
          aria-label={t('setup.simbrief.label')}
          placeholder="Navigraph Alias"
          value={username}
          onChange={(e) => {
            setUsername(e.target.value)
            setSaved(false)
          }}
        />
        <Button type="submit" variant="outline" disabled={username.trim() === ''}>
          {t('setup.simbrief.save')}
        </Button>
      </div>
      <p role="status" className="text-xs text-muted-foreground">
        {saved ? t('setup.simbrief.saved') : ''}
      </p>
    </form>
  )
}

function OnOffRow(props: {
  label: string
  value: boolean | null
  onChange: (value: boolean) => void
  detail: string
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-1">
      {props.value === null ? (
        <span className="text-sm text-muted-foreground">{props.label}</span>
      ) : (
        <SegmentedRow
          label={props.label}
          value={props.value ? 'on' : 'off'}
          options={[
            { value: 'on', label: t('setup.on') },
            { value: 'off', label: t('setup.off') }
          ]}
          onChange={(value) => props.onChange(value === 'on')}
        />
      )}
      <p className="text-xs text-muted-foreground">{props.detail}</p>
    </div>
  )
}

function AddonsStep(props: {
  onGsxRemoteEnabledChange: (enabled: boolean) => void
  onBeyondAtcEnabledChange: (enabled: boolean) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [context, setContext] = useState<SetupContext | null>(null)
  const [gsx, setGsx] = useState<GsxSettings | null>(null)
  const [gsxRemote, setGsxRemote] = useState<GsxRemoteSettings | null>(null)
  const [beyondAtc, setBeyondAtc] = useState<BeyondAtcSettings | null>(null)
  useEffect(() => {
    runAsync('SetupDialog setupGetContext', window.winglog.setupGetContext().then(setContext))
    runAsync('SetupDialog settingsGetGsx', window.winglog.settingsGetGsx().then(setGsx))
    runAsync('SetupDialog settingsGetGsxRemote', window.winglog.settingsGetGsxRemote().then(setGsxRemote))
    runAsync('SetupDialog settingsGetBeyondAtc', window.winglog.settingsGetBeyondAtc().then(setBeyondAtc))
  }, [])

  function setGsxEnabled(enabled: boolean): void {
    if (!gsx) return
    // Turning it on with no folder chosen yet uses GSX's standard one, when it exists.
    const next = {
      ...gsx,
      enabled,
      folderPath: gsx.folderPath ?? (context?.gsxFolderFound ? context.gsxFolderPath : null)
    }
    setGsx(next)
    runAsync('SetupDialog settingsSetGsx', window.winglog.settingsSetGsx(next))
  }

  function setGsxRemoteEnabled(enabled: boolean): void {
    if (!gsxRemote) return
    const next = { ...gsxRemote, enabled }
    setGsxRemote(next)
    props.onGsxRemoteEnabledChange(enabled)
    runAsync('SetupDialog settingsSetGsxRemote', window.winglog.settingsSetGsxRemote(next))
  }

  function setBeyondAtcEnabled(enabled: boolean): void {
    if (!beyondAtc) return
    const next = { ...beyondAtc, enabled }
    setBeyondAtc(next)
    props.onBeyondAtcEnabledChange(enabled)
    runAsync('SetupDialog settingsSetBeyondAtc', window.winglog.settingsSetBeyondAtc(next))
  }

  const gsxFolder =
    context === null
      ? ''
      : context.gsxFolderFound
        ? t('setup.addons.gsxFound')
        : t('setup.addons.gsxNotFound')
  const atcRunning = context?.beyondAtcRunning ? ` ${t('setup.addons.beyondAtcRunning')}` : ''
  return (
    <>
      <p className="text-sm text-muted-foreground">{t('setup.addons.intro')}</p>
      <OnOffRow
        label={t('setup.addons.gsx')}
        value={gsx?.enabled ?? null}
        onChange={setGsxEnabled}
        detail={`${t('setup.addons.gsxDetail')} ${gsxFolder}`.trim()}
      />
      <OnOffRow
        label={t('setup.addons.gsxRemote')}
        value={gsxRemote?.enabled ?? null}
        onChange={setGsxRemoteEnabled}
        detail={t('setup.addons.gsxRemoteDetail')}
      />
      <OnOffRow
        label={t('setup.addons.beyondAtc')}
        value={beyondAtc?.enabled ?? null}
        onChange={setBeyondAtcEnabled}
        detail={`${t('setup.addons.beyondAtcDetail')}${atcRunning}`}
      />
      <p className="text-xs text-muted-foreground">{t('setup.addons.notAffiliated')}</p>
    </>
  )
}

function UpdatesStep(): React.JSX.Element {
  const { t } = useTranslation()
  const [settings, setSettings] = useState<UpdateSettings | null>(null)
  useEffect(() => {
    runAsync('SetupDialog settingsGetUpdates', window.winglog.settingsGetUpdates().then(setSettings))
  }, [])
  return (
    <OnOffRow
      label={t('updates.settings.autoCheck')}
      value={settings?.checkEnabled ?? null}
      onChange={(checkEnabled) => {
        setSettings({ checkEnabled })
        runAsync('SetupDialog settingsSetUpdates', window.winglog.settingsSetUpdates({ checkEnabled }))
      }}
      detail={t('updates.settings.description')}
    />
  )
}
