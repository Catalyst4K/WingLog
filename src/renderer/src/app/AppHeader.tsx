/** The app's header: the tab strip and the sim connection badge. */

import { BookOpen, Plane, Radar, Radio, Route, Settings as SettingsIcon, Truck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { AppPage, SimConnectionStatus } from '@shared/ipc'
import { Badge } from '@/components/ui/badge'
import { TabsList, TabsTrigger } from '@/components/ui/tabs'
import { DevBuildBadge } from '../DevBuildBadge'

/**
 * The tabs, in order. GSX Remote Control and BeyondATC's own tabs are gated on their settings'
 * `enabled` flag — hidden until turned on in Settings, rather than always
 * shown regardless of configuration.
 *
 * @param t The translation function.
 * @param gsxRemoteEnabled Whether GSX Remote Control is turned on.
 * @param beyondAtcEnabled Whether BeyondATC is turned on.
 * @returns Each tab's page, label and icon.
 */
function appTabs(
  t: TFunction,
  gsxRemoteEnabled: boolean,
  beyondAtcEnabled: boolean
): { page: AppPage; label: string; icon: typeof Plane }[] {
  return [
    { page: 'fleet', label: t('app.tabs.fleet'), icon: Plane },
    { page: 'dispatch', label: t('app.tabs.dispatch'), icon: Route },
    { page: 'track', label: t('app.tabs.track'), icon: Radar },
    ...(gsxRemoteEnabled ? [{ page: 'gsx' as const, label: t('app.tabs.gsx'), icon: Truck }] : []),
    ...(beyondAtcEnabled
      ? [{ page: 'beyondatc' as const, label: t('app.tabs.beyondAtc'), icon: Radio }]
      : []),
    { page: 'logbook', label: t('app.tabs.logbook'), icon: BookOpen },
    { page: 'settings', label: t('app.tabs.settings'), icon: SettingsIcon }
  ]
}

function connectionStatusLabel(status: SimConnectionStatus, t: TFunction): string {
  switch (status.state) {
    case 'connected':
      return t('app.connection.connected', { version: status.simConnectVersion })
    case 'connecting':
      return t('app.connection.connecting')
    case 'disconnected':
      return t('app.connection.disconnected')
  }
}

function connectionStateLabel(status: SimConnectionStatus, t: TFunction): string {
  return t(`app.connection.states.${status.state}`)
}

function connectionStatusVariant(status: SimConnectionStatus): 'default' | 'secondary' | 'destructive' {
  switch (status.state) {
    case 'connected':
      return 'default'
    case 'connecting':
      return 'secondary'
    case 'disconnected':
      return 'destructive'
  }
}

/**
 * The header: one tab per enabled page, then the dev-build and connection badges.
 *
 * @param props Which optional tabs exist, the tab-click handler, and the sim connection status.
 * @returns The element.
 */
export function AppHeader(props: {
  gsxRemoteEnabled: boolean
  beyondAtcEnabled: boolean
  onTabClick: (page: AppPage) => void
  simStatus: SimConnectionStatus
}): React.JSX.Element {
  const { t } = useTranslation()
  const { simStatus } = props
  return (
    // Narrow windows (a second monitor, and later a tablet or phone): tabs drop to icons
    // below lg, keeping each label for screen readers, and scroll if they still don't fit.
    // px-1 below sm is what fits all seven next to the phone badge at 360 px: px-1.5 left
    // the row 16 px short and Settings half off screen (v1.4.0's red e2e).
    <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3 sm:gap-4 sm:px-6">
      <TabsList
        variant="line"
        className="min-w-0 justify-start overflow-x-auto overflow-y-hidden [scrollbar-width:none]"
      >
        {appTabs(t, props.gsxRemoteEnabled, props.beyondAtcEnabled).map(
          ({ page: tabPage, label, icon: Icon }) => (
            <TabsTrigger
              key={tabPage}
              value={tabPage}
              className="gap-1.5 px-1 sm:px-3"
              aria-label={label}
              onClick={() => props.onTabClick(tabPage)}
            >
              <Icon />
              {/* Hidden below lg; the tab keeps its name through aria-label. Not sr-only/lg:not-sr-only:
                not-sr-only resets white-space, which wrapped "Ground services" under the underline. */}
              <span className="hidden lg:inline">{label}</span>
            </TabsTrigger>
          )
        )}
      </TabsList>
      <div className="flex shrink-0 items-center gap-2">
        <DevBuildBadge />
        <Badge
          variant={connectionStatusVariant(simStatus)}
          title={connectionStatusLabel(simStatus, t)}
          className="shrink-0"
        >
          <span className="sm:hidden">{connectionStateLabel(simStatus, t)}</span>
          <span className="hidden sm:inline">
            {t('app.connection.badge', { state: connectionStateLabel(simStatus, t) })}
          </span>
        </Badge>
      </div>
    </header>
  )
}
