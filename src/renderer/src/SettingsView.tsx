/**
 * The Settings tab: a list of pages down the side in three groups (winglog-backend's docs/plans/v2-design.md, Part 5), one page open at
 * a time. Each card's state is a hook in settings/use-settings-state.ts; the cards are in settings/.
 */

import { winglogApi } from './data/winglog-api'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import type {
  AltitudeUnit,
  AppLanguage,
  LandingDistanceUnit,
  MapLanguage,
  Theme,
  WeightUnit,
  WindSpeedUnit
} from '@shared/ipc'
import { LanguageRows, SegmentedRow, TrackingFields, UnitRows } from './SettingsFields'
import { trackingLabels } from './tracking-labels'
import { UpdatesCard } from './UpdatesCard'
import { LanCard } from './settings/LanCard'
import { WindowCard } from './settings/WindowCard'
import { SettingsCard } from './settings/ui/SettingsCard'
import type { LightState } from '@/components/StatusLight'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent } from '@/components/ui/tabs'
import { SettingsNav, type SettingsCategory } from './settings/SettingsNav'
import { HostLinkCard } from './settings/HostLinkCard'
import { RunModeCard } from './settings/RunModeCard'
import { useCapabilities } from './app/capabilities-context'
import { hostLinkLight, useHostLinkStatus } from './app/use-host-link'
import { useSettingsNavStatus } from './settings/use-settings-nav-status'
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

const DEFAULT_SETTINGS_CATEGORY: SettingsCategory = 'general'
/** Every page is one column of sections (the width is SettingsCard's); the sections space themselves. */
const PANEL = 'flex min-w-0 flex-col'
/** A page's own box beside the list: room to the left of it, and the rest of the width. */
const PAGE = 'min-w-0 flex-1 px-0 pt-1 pb-8 @3xl:px-10'

/**
 * The light on an add-on's page: what the connection is doing, not only whether the add-on is switched on.
 *
 * @param enabled Whether the add-on is turned on.
 * @param state The add-on's connection.
 * @returns Off when turned off; green when connected; amber while it is turned on but not connected (connecting, or its program is not running).
 */
function addonLight(enabled: boolean, state: 'connected' | 'connecting' | 'disconnected'): LightState {
  if (!enabled) return 'off'
  return state === 'connected' ? 'green' : 'amber'
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
        <UnitRows
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

      <SettingsCard title={t('settingsView.language.cardTitle')}>
        <LanguageRows
          mapLanguage={props.mapLanguage}
          onMapLanguageChange={props.onMapLanguageChange}
          appLanguage={props.appLanguage}
          onAppLanguageChange={props.onAppLanguageChange}
        />
      </SettingsCard>

      <WindowCard
        title={t('settingsView.appearance.cardTitle')}
        lead={
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
        }
      />

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
 * A page of the Settings list: its name large, one line of what it is for, then its sections (the canvas's r3-settings).
 *
 * @param props The page and its sections.
 * @returns The element.
 */
function SettingsPage(props: { category: SettingsCategory; children: React.ReactNode }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className={PANEL}>
      <header className="max-w-[760px]">
        <h2 className="m-0 font-display text-[34px] leading-[1.1] font-bold tracking-[-0.02em]">
          {t(`settingsView.categories.${props.category}`)}
        </h2>
        <p className="m-0 mt-1 text-sm text-muted-foreground">
          {t(`settingsView.pageLede.${props.category}`)}
        </p>
      </header>
      <div className={`${PANEL} mt-[26px]`}>{props.children}</div>
    </div>
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
      <p className="text-xs text-muted-foreground">{t('settingsView.about.credits')}</p>
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
  // A client is not the sim's host: the pages of what only the sim PC runs are not offered, and a Sim PC page pairs it (multi-device builds).
  const { runMode, multiDevice } = useCapabilities()
  const isClient = runMode === 'client'
  const hostLink = useHostLinkStatus(isClient)
  // Called in the order the settings used to load in, so the IPC calls go out in that order.
  const credentials = useSimbriefCredentials()
  const gsx = useGsxSettings()
  const gsxRemote = useGsxRemoteSettings(props.onGsxRemoteEnabledChange)
  const beyondAtc = useBeyondAtcSettings(props.onBeyondAtcEnabledChange)
  const sync = useCloudSync()
  const data = useDataTransfer()
  const navStatus = useSettingsNavStatus()
  const [appVersion, setAppVersion] = useState('')
  // Purely transient UI state, not persisted — this app has no routing beyond the top tab
  // bar, no reason to add any for a sub-navigation within one of its pages.
  const [category, setCategory] = useState<SettingsCategory>(DEFAULT_SETTINGS_CATEGORY)
  useResetSignal(props.resetSignal, () => setCategory(DEFAULT_SETTINGS_CATEGORY))

  useEffect(() => {
    runAsync('SettingsView appGetVersion', winglogApi().appGetVersion().then(setAppVersion))
  }, [])

  return (
    <div className="@container flex flex-col gap-6">
      <h1 className="sr-only">{t('settingsView.title')}</h1>

      <Tabs
        orientation="vertical"
        value={category}
        onValueChange={(value) => setCategory(value as SettingsCategory)}
        className="flex-col items-start gap-0 @3xl:flex-row"
      >
        <SettingsNav
          category={category}
          onChange={setCategory}
          status={{
            gsxRemote: addonLight(gsxRemote.settings.enabled, gsxRemote.status.state),
            beyondAtc: addonLight(beyondAtc.settings.enabled, beyondAtc.status.state),
            ...navStatus,
            simPc: isClient && hostLink ? { light: hostLinkLight(hostLink.state) } : {}
          }}
          mode={{ multiDevice, isClient }}
        />

        <TabsContent value="general" className={PAGE}>
          <SettingsPage category="general">
            <InterfacePanel {...props} />
          </SettingsPage>
        </TabsContent>

        <TabsContent value="simPc" className={PAGE}>
          <SettingsPage category="simPc">
            {isClient && <HostLinkCard />}
            <RunModeCard />
          </SettingsPage>
        </TabsContent>

        <TabsContent value="secondScreen" className={PAGE}>
          <SettingsPage category="secondScreen">
            <LanCard />
          </SettingsPage>
        </TabsContent>

        <TabsContent value="accounts" className={PAGE}>
          <SettingsPage category="accounts">
            <CredentialsCard credentials={credentials} />
          </SettingsPage>
        </TabsContent>

        <TabsContent value="gsx" className={PAGE}>
          <SettingsPage category="gsx">
            <GsxCard gsx={gsx} />
            <GsxRemoteCard gsxRemote={gsxRemote} />
          </SettingsPage>
        </TabsContent>

        <TabsContent value="beyondAtc" className={PAGE}>
          <SettingsPage category="beyondAtc">
            <BeyondAtcCard beyondAtc={beyondAtc} />
          </SettingsPage>
        </TabsContent>

        <TabsContent value="online" className={PAGE}>
          <SettingsPage category="online">
            <OnlineNetworkCard />
          </SettingsPage>
        </TabsContent>

        <TabsContent value="navdata" className={PAGE}>
          <SettingsPage category="navdata">
            <NavdataCard />
          </SettingsPage>
        </TabsContent>

        <TabsContent value="data" className={PAGE}>
          <SettingsPage category="data">
            <DataCard data={data} />
            {/* Cloud sync build-time flag (docs/plans/public-release-v1.md, Decision 1) —
                hidden entirely in a public build, not just disabled: the syncLogin/etc.
                channels this card calls don't exist there at all (see index.ts). */}
            {/* v8 ignore next -- vitest.config.ts's `define` fixes the flag at `true`, so the
                "hidden in a public build" arm of this && can't be exercised in this test run. */}
            {__WINGLOG_CLOUD_SYNC_ENABLED__ && <CloudSyncCard sync={sync} />}
          </SettingsPage>
        </TabsContent>

        <TabsContent value="about" className={PAGE}>
          <SettingsPage category="about">
            <AboutCard appVersion={appVersion} onRunSetup={props.onRunSetup} />
            <UpdatesCard />
          </SettingsPage>
        </TabsContent>
      </Tabs>
    </div>
  )
}
