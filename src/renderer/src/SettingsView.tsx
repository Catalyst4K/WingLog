/**
 * The Settings tab: a list of pages down the side in three groups (winglog-backend's docs/plans/v2-design.md, Part 5), one page open at
 * a time. Each card's state is a hook in settings/use-settings-state.ts; the cards are in settings/.
 */

import { winglogApi } from './data/winglog-api'
import { useEffect, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type {
  AltitudeUnit,
  AppLanguage,
  LandingDistanceUnit,
  MapLanguage,
  Theme,
  WeightUnit,
  WindSpeedUnit
} from '@shared/ipc'
import { SegmentedRow, TrackingFields, UnitsFields } from './SettingsFields'
import { trackingLabels } from './tracking-labels'
import { UpdatesCard } from './UpdatesCard'
import { LanCard } from './settings/LanCard'
import { WindowCard } from './settings/WindowCard'
import { SettingsCard } from './settings/ui/SettingsCard'
import { StatusLight, type LightState } from '@/components/StatusLight'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useResetSignal } from './hooks/use-reset-signal'
import { asyncHandler, runAsync } from './report-error'
import { BeyondAtcCard, CredentialsCard, GsxCard, GsxRemoteCard } from './settings/AddonCards'
import { NavdataCard } from './navdata/NavdataCycle'
import { OnlineNetworkCard } from './settings/OnlineNetworkCard'
import { CloudSyncCard, DataCard } from './settings/DataCards'
import {
  useBeyondAtcSettings,
  useCloudSync,
  useDataTransfer,
  useGsxRemoteSettings,
  useGsxSettings,
  useSimbriefCredentials
} from './settings/use-settings-state'

type SettingsCategory =
  'general' | 'secondScreen' | 'accounts' | 'gsx' | 'beyondAtc' | 'online' | 'navdata' | 'data' | 'about'
const DEFAULT_SETTINGS_CATEGORY: SettingsCategory = 'general'
/** Every page is one column of equal-width cards (the width is SettingsCard's). */
const PANEL = 'flex min-w-0 flex-col gap-4'

/** A page in the list down the side. */
interface SettingsPage {
  value: SettingsCategory
  label: string
  /** A light for add-ons that can be on or off: green on, off when turned off. Absent for pages with nothing to be on. */
  light?: LightState
}

/**
 * @param t The translation function.
 * @param lights Whether GSX Remote Control and BeyondATC are turned on.
 * @returns The pages down the side, in their three groups.
 */
function settingsGroups(
  t: TFunction,
  lights: { gsxRemote: boolean; beyondAtc: boolean }
): { label: string; pages: SettingsPage[] }[] {
  const onOff = (on: boolean): LightState => (on ? 'green' : 'off')
  return [
    {
      label: t('settingsView.groups.app'),
      pages: [
        { value: 'general', label: t('settingsView.categories.general') },
        { value: 'secondScreen', label: t('settingsView.categories.secondScreen') }
      ]
    },
    {
      label: t('settingsView.groups.addons'),
      pages: [
        { value: 'accounts', label: t('settingsView.categories.accounts') },
        { value: 'gsx', label: t('settingsView.categories.gsx'), light: onOff(lights.gsxRemote) },
        { value: 'beyondAtc', label: t('settingsView.categories.beyondAtc'), light: onOff(lights.beyondAtc) },
        { value: 'online', label: t('settingsView.categories.online') },
        { value: 'navdata', label: t('settingsView.categories.navdata') }
      ]
    },
    {
      label: t('settingsView.groups.yourData'),
      pages: [
        { value: 'data', label: t('settingsView.categories.data') },
        { value: 'about', label: t('settingsView.categories.about') }
      ]
    }
  ]
}

/** The unit, language and theme settings App owns, with their change handlers. */
interface AppWideSettings {
  weightUnit: WeightUnit
  onWeightUnitChange: (unit: WeightUnit) => void
  altitudeUnit: AltitudeUnit
  onAltitudeUnitChange: (unit: AltitudeUnit) => void
  windSpeedUnit: WindSpeedUnit
  onWindSpeedUnitChange: (unit: WindSpeedUnit) => void
  landingDistanceUnit: LandingDistanceUnit
  onLandingDistanceUnitChange: (unit: LandingDistanceUnit) => void
  mapLanguage: MapLanguage
  onMapLanguageChange: (language: MapLanguage) => void
  appLanguage: AppLanguage
  onAppLanguageChange: (language: AppLanguage) => void
  theme: Theme
  onThemeChange: (theme: Theme) => void
}

/**
 * Settings → General: units and languages, theme, the window, and automatic tracking.
 *
 * @param props The app-wide settings and their change handlers.
 * @returns The element.
 */
function InterfacePanel(props: AppWideSettings): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <>
      <SettingsCard title={t('settingsView.units.cardTitle')}>
        <UnitsFields
          weightUnit={props.weightUnit}
          onWeightUnitChange={props.onWeightUnitChange}
          altitudeUnit={props.altitudeUnit}
          onAltitudeUnitChange={props.onAltitudeUnitChange}
          windSpeedUnit={props.windSpeedUnit}
          onWindSpeedUnitChange={props.onWindSpeedUnitChange}
          landingDistanceUnit={props.landingDistanceUnit}
          onLandingDistanceUnitChange={props.onLandingDistanceUnitChange}
          mapLanguage={props.mapLanguage}
          onMapLanguageChange={props.onMapLanguageChange}
          appLanguage={props.appLanguage}
          onAppLanguageChange={props.onAppLanguageChange}
        />
      </SettingsCard>

      <SettingsCard title={t('settingsView.theme.cardTitle')}>
        <SegmentedRow
          label={t('settingsView.theme.appearance')}
          value={props.theme}
          options={[
            { value: 'light', label: t('settingsView.theme.light') },
            { value: 'dark', label: t('settingsView.theme.dark') },
            { value: 'system', label: t('settingsView.theme.system') }
          ]}
          onChange={props.onThemeChange}
        />
      </SettingsCard>

      <WindowCard />

      <SettingsCard
        title={t('settingsView.tracking.cardTitle')}
        description={t('settingsView.tracking.description', trackingLabels(t))}
      >
        <TrackingFields />
      </SettingsCard>
    </>
  )
}

/**
 * Settings → About: the version, the disclaimer, the manual and the setup.
 *
 * @param props The app version, and the handler that reruns the setup.
 * @returns The element.
 */
function AboutCard(props: { appVersion: string; onRunSetup?: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <SettingsCard
      title={`WingLog${props.appVersion ? ` v${props.appVersion}` : ''}`}
      description={t('settingsView.about.description')}
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={asyncHandler('SettingsView appOpenManual', async () => {
              if (!(await winglogApi().appOpenManual())) toast.error(t('settingsView.about.manualMissing'))
            })}
          >
            {t('settingsView.about.openManual')}
          </Button>
          {props.onRunSetup && (
            <Button type="button" variant="outline" size="sm" onClick={props.onRunSetup}>
              {t('settingsView.about.runSetup')}
            </Button>
          )}
        </>
      }
    >
      <p className="text-sm font-medium text-foreground">{t('settingsView.about.simulationOnly')}</p>
      <p className="text-sm text-foreground">{t('settingsView.about.disclaimer')}</p>
      <p className="text-xs text-muted-foreground">
        {t('settingsView.about.license')}{' '}
        <button
          type="button"
          onClick={asyncHandler('SettingsView appOpenGithub', () => winglogApi().appOpenGithub())}
          className="cursor-pointer underline underline-offset-2 hover:text-foreground"
        >
          github.com/Catalyst4K/WingLog
        </button>
      </p>
    </SettingsCard>
  )
}

/**
 * The Settings tab.
 *
 * @param props Each app-wide setting and its change handler.
 * @returns The element.
 */
export function SettingsView(
  props: AppWideSettings & {
    /** Mirrors this toggle's live value up to App.tsx, which gates the GSX Remote Control tab
     *  on it — App.tsx doesn't otherwise see this card's own settings
     *  state, which lives entirely in this component. */
    onGsxRemoteEnabledChange: (enabled: boolean) => void
    /** Same reasoning as onGsxRemoteEnabledChange, for the BeyondATC tab. */
    onBeyondAtcEnabledChange: (enabled: boolean) => void
    /** Settings → About → "Run setup again" reopens the first-launch setup. */
    onRunSetup?: () => void
    /** Bumped by App.tsx when the Settings tab is clicked while already active — returns to
     *  the first category (docs/plans/navigation-tab-behaviour.md). See useResetSignal. */
    resetSignal?: number
  }
): React.JSX.Element {
  const { t } = useTranslation()
  // Called in the order the settings used to load in, so the IPC calls go out in that order.
  const credentials = useSimbriefCredentials()
  const gsx = useGsxSettings()
  const gsxRemote = useGsxRemoteSettings(props.onGsxRemoteEnabledChange)
  const beyondAtc = useBeyondAtcSettings(props.onBeyondAtcEnabledChange)
  const sync = useCloudSync()
  const data = useDataTransfer()
  const [appVersion, setAppVersion] = useState('')
  // Purely transient UI state, not persisted — this app has no routing beyond the top tab
  // bar, no reason to add any for a sub-navigation within one of its pages.
  const [category, setCategory] = useState<SettingsCategory>(DEFAULT_SETTINGS_CATEGORY)
  useResetSignal(props.resetSignal, () => setCategory(DEFAULT_SETTINGS_CATEGORY))

  useEffect(() => {
    runAsync('SettingsView appGetVersion', winglogApi().appGetVersion().then(setAppVersion))
  }, [])

  return (
    <div className="flex flex-col gap-6">
      <h1 className="sr-only">{t('settingsView.title')}</h1>

      <Tabs
        orientation="vertical"
        value={category}
        onValueChange={(value) => setCategory(value as SettingsCategory)}
        className="items-start gap-6"
      >
        <TabsList
          variant="line"
          className="w-52 shrink-0 gap-3 self-stretch border-r border-border/40 pr-3 group-data-vertical/tabs:items-stretch"
        >
          {settingsGroups(t, {
            gsxRemote: gsxRemote.settings.enabled,
            beyondAtc: beyondAtc.settings.enabled
          }).map((group) => (
            <div key={group.label} role="presentation" className="flex flex-col gap-0.5">
              <span aria-hidden="true" className="px-1.5 pb-1 text-xs text-muted-foreground">
                {group.label}
              </span>
              {group.pages.map(({ value, label, light }) => (
                <TabsTrigger key={value} value={value}>
                  {label}
                  {light && <StatusLight state={light} className="ml-1" />}
                  {category === value && (
                    <ChevronRight data-testid="settings-active-chevron" className="ml-auto" />
                  )}
                </TabsTrigger>
              ))}
            </div>
          ))}
        </TabsList>

        <TabsContent value="general" className={PANEL}>
          <InterfacePanel {...props} />
        </TabsContent>

        <TabsContent value="secondScreen" className={PANEL}>
          <LanCard />
        </TabsContent>

        <TabsContent value="accounts" className={PANEL}>
          <CredentialsCard credentials={credentials} />
        </TabsContent>

        <TabsContent value="gsx" className={PANEL}>
          <GsxCard gsx={gsx} />
          <GsxRemoteCard gsxRemote={gsxRemote} />
        </TabsContent>

        <TabsContent value="beyondAtc" className={PANEL}>
          <BeyondAtcCard beyondAtc={beyondAtc} />
        </TabsContent>

        <TabsContent value="online" className={PANEL}>
          <OnlineNetworkCard />
        </TabsContent>

        <TabsContent value="navdata" className={PANEL}>
          <NavdataCard />
        </TabsContent>

        <TabsContent value="data" className={PANEL}>
          <DataCard data={data} />
          {/* Cloud sync build-time flag (docs/plans/public-release-v1.md, Decision 1) —
                hidden entirely in a public build, not just disabled: the syncLogin/etc.
                channels this card calls don't exist there at all (see index.ts). */}
          {/* v8 ignore next -- vitest.config.ts's `define` fixes the flag at `true`, so the
                "hidden in a public build" arm of this && can't be exercised in this test run. */}
          {__WINGLOG_CLOUD_SYNC_ENABLED__ && <CloudSyncCard sync={sync} />}
        </TabsContent>

        <TabsContent value="about" className={PANEL}>
          <AboutCard appVersion={appVersion} onRunSetup={props.onRunSetup} />
          <UpdatesCard />
        </TabsContent>
      </Tabs>
    </div>
  )
}
