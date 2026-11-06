/** The app's header: the tab strip, the online badge and the sim connection badge. */

import { ChevronDown } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { AppPage, SimConnectionStatus } from '@shared/ipc'
import { StatusLight, type LightState } from '@/components/StatusLight'
import { useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useNarrowWindow } from '../hooks/use-narrow-window'
import { cn } from '@/lib/utils'
import { DevBuildBadge } from '../DevBuildBadge'
import { OnlineBadge } from '../online/OnlineBadge'

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
): { page: AppPage; label: string }[] {
  return [
    { page: 'fleet', label: t('app.tabs.fleet') },
    { page: 'dispatch', label: t('app.tabs.dispatch') },
    { page: 'track', label: t('app.tabs.track') },
    ...(gsxRemoteEnabled ? [{ page: 'gsx' as const, label: t('app.tabs.gsx') }] : []),
    ...(beyondAtcEnabled ? [{ page: 'beyondatc' as const, label: t('app.tabs.beyondAtc') }] : []),
    { page: 'logbook', label: t('app.tabs.logbook') },
    { page: 'settings', label: t('app.tabs.settings') }
  ]
}

/** The tabs that stay in the bar however narrow the window is; the others go behind "More". */
const ALWAYS_SHOWN: AppPage[] = ['fleet', 'dispatch', 'track', 'logbook']

/**
 * The tabs folded away in a narrow window: a "More" button that opens a short list (winglog-backend docs/plans/v2-design.md, D9). Its
 * label is the page you are on when that is one of them, underlined like a tab, so the bar still says where you are.
 *
 * @param props The folded tabs, the page open, and the handler.
 * @returns The element.
 */
function MoreTabs(props: {
  items: { page: AppPage; label: string }[]
  current: AppPage | undefined
  onPick: (page: AppPage) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const active = props.items.find((item) => item.page === props.current)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'relative inline-flex h-8 shrink-0 items-center gap-1 px-3 text-[0.9375rem] font-medium whitespace-nowrap outline-none',
            'after:absolute after:inset-x-0 after:bottom-[-5px] after:h-0.5 after:bg-foreground',
            active ? 'text-foreground' : 'text-foreground/60 after:opacity-0',
            'hover:text-foreground focus-visible:text-foreground'
          )}
        >
          {active ? active.label : t('app.tabs.more')}
          <ChevronDown aria-hidden="true" className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-48 p-1">
        <ul className="flex flex-col">
          {props.items.map((item) => (
            <li key={item.page}>
              <button
                type="button"
                className={cn(
                  'flex w-full items-center rounded-md px-3 py-2 text-left text-sm hover:bg-muted',
                  item.page === props.current && 'font-medium'
                )}
                onClick={() => {
                  setOpen(false)
                  props.onPick(item.page)
                }}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
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

/**
 * The sim connection as a light: green connected, amber connecting, red lost.
 *
 * @param status The sim connection status.
 * @returns The light's state.
 */
function connectionLight(status: SimConnectionStatus): LightState {
  switch (status.state) {
    case 'connected':
      return 'green'
    case 'connecting':
      return 'amber'
    case 'disconnected':
      return 'red'
  }
}

/**
 * The header: one tab per enabled page, then the dev-build and online badges and the sim connection light.
 *
 * @param props Which optional tabs exist, the tab-click handler, and the sim connection status.
 * @returns The element.
 */
export function AppHeader(props: {
  gsxRemoteEnabled: boolean
  beyondAtcEnabled: boolean
  onTabClick: (page: AppPage) => void
  /** The page open, so the "More" button can say when it is one of the folded ones. */
  current?: AppPage
  simStatus: SimConnectionStatus
}): React.JSX.Element {
  const { t } = useTranslation()
  const { simStatus } = props
  const narrow = useNarrowWindow()
  const tabs = appTabs(t, props.gsxRemoteEnabled, props.beyondAtcEnabled)
  const shown = narrow ? tabs.filter((tab) => ALWAYS_SHOWN.includes(tab.page)) : tabs
  const folded = narrow ? tabs.filter((tab) => !ALWAYS_SHOWN.includes(tab.page)) : []
  return (
    // Text-only tabs (v2). In a narrow window the less-used ones fold behind a "More" menu (D9), and anything still too wide wraps.
    <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-2 sm:gap-4 sm:px-6">
      <TabsList variant="line" className="h-auto min-w-0 flex-wrap justify-start">
        {shown.map(({ page: tabPage, label }) => (
          <TabsTrigger
            key={tabPage}
            value={tabPage}
            className="px-3 text-[0.9375rem]"
            onClick={() => props.onTabClick(tabPage)}
          >
            {label}
          </TabsTrigger>
        ))}
      </TabsList>
      {folded.length > 0 && <MoreTabs items={folded} current={props.current} onPick={props.onTabClick} />}
      <div className="flex shrink-0 items-center gap-2">
        <DevBuildBadge />
        {/* Not below sm: the tabs and the sim light only just fit at 360 px. */}
        <OnlineBadge className="hidden sm:inline-flex" />
        <span
          title={connectionStatusLabel(simStatus, t)}
          className={cn(
            'flex shrink-0 items-center gap-2 text-sm',
            simStatus.state === 'disconnected' ? 'text-destructive' : 'text-muted-foreground'
          )}
        >
          {/* The word and the lights only; the state is in the lights' colour, the tooltip and, for a screen reader, here. */}
          <span aria-hidden="true">{t('app.connection.label')}</span>
          <StatusLight state={connectionLight(simStatus)} count={3} />
          <span className="sr-only">
            {t('app.connection.badge', { state: connectionStateLabel(simStatus, t) })}
          </span>
        </span>
      </div>
    </header>
  )
}
