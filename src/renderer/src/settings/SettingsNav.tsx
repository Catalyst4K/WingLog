/**
 * Settings' list of pages (winglog-backend docs/plans/v2-design.md, Part 5 and Part 8): three groups down the side, each page with its
 * light and a few words of status; in a narrow window the same list is a picker at the top of the page, keeping the light.
 */

import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { StatusLight, type LightState } from '@/components/StatusLight'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { TabsList, TabsTrigger } from '@/components/ui/tabs'

export type SettingsCategory =
  | 'general'
  | 'simPc'
  | 'secondScreen'
  | 'accounts'
  | 'gsx'
  | 'beyondAtc'
  | 'online'
  | 'navdata'
  | 'data'
  | 'about'

/** A page in the list: its light, and a few quiet words beside it. */
interface SettingsPage {
  value: SettingsCategory
  label: string
  /** A light: green connected, amber waiting or needing a look, off when turned off. Absent for pages that have none. */
  light?: LightState
  /** A few words of state beside the light ("1 phone", "Update ready"). */
  status?: string
}

/** What the list shows beside the pages that have something to say. */
export interface SettingsNavStatus {
  gsxRemote: LightState
  beyondAtc: LightState
  secondScreen: { light?: LightState; status?: string }
  /** The Sim PC page's light (multi-device builds): the link to the sim PC on a client. */
  simPc: { light?: LightState; status?: string }
  about: { light?: LightState; status?: string }
}

/** Which pages the list leaves out: the Sim PC page unless multi-device is built in, and on a client the pages of what only the sim PC runs. */
export interface SettingsNavMode {
  multiDevice: boolean
  isClient: boolean
}

/**
 * @param t The translation function.
 * @param status The lights and status words.
 * @param mode Whether multi-device is built in and whether this is a client.
 * @returns The pages, in their three groups.
 */
function settingsGroups(
  t: TFunction,
  status: SettingsNavStatus,
  mode: SettingsNavMode
): { label: string; pages: SettingsPage[] }[] {
  const hostPages = (pages: SettingsPage[]): SettingsPage[] => (mode.isClient ? [] : pages)
  return [
    {
      label: t('settingsView.groups.app'),
      pages: [
        { value: 'general', label: t('settingsView.categories.general') },
        ...(mode.multiDevice
          ? [{ value: 'simPc' as const, label: t('settingsView.categories.simPc'), ...status.simPc }]
          : []),
        ...hostPages([
          { value: 'secondScreen', label: t('settingsView.categories.secondScreen'), ...status.secondScreen }
        ])
      ]
    },
    {
      label: t('settingsView.groups.addons'),
      pages: [
        { value: 'accounts', label: t('settingsView.categories.accounts') },
        ...hostPages([
          { value: 'gsx', label: t('settingsView.categories.gsx'), light: status.gsxRemote },
          { value: 'beyondAtc', label: t('settingsView.categories.beyondAtc'), light: status.beyondAtc },
          { value: 'online', label: t('settingsView.categories.online') },
          { value: 'navdata', label: t('settingsView.categories.navdata') }
        ])
      ]
    },
    {
      label: t('settingsView.groups.yourData'),
      pages: [
        { value: 'data', label: t('settingsView.categories.data') },
        { value: 'about', label: t('settingsView.categories.about'), ...status.about }
      ]
    }
  ]
}

/**
 * The list of pages: down the side from the page's wrap width up (the page's `@container`), a picker above it below that.
 *
 * @param props The open page, what to do when another is chosen, and the lights and words.
 * @returns The element.
 */
export function SettingsNav(props: {
  category: SettingsCategory
  onChange: (category: SettingsCategory) => void
  status: SettingsNavStatus
  mode: SettingsNavMode
}): React.JSX.Element {
  const { t } = useTranslation()
  const groups = settingsGroups(t, props.status, props.mode)
  return (
    <>
      <div className="w-full pb-4 @3xl:hidden">
        <Select value={props.category} onValueChange={(value) => props.onChange(value as SettingsCategory)}>
          <SelectTrigger className="w-full" aria-label={t('settingsView.pagePicker')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {groups.map((group) => (
              <SelectGroup key={group.label}>
                <SelectLabel>{group.label}</SelectLabel>
                {group.pages.map(({ value, label, light, status }) => (
                  <SelectItem key={value} value={value}>
                    <span className="flex items-center gap-2">
                      {label}
                      {status && <span className="text-xs text-muted-foreground">{status}</span>}
                      {light && <StatusLight state={light} />}
                    </span>
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
      </div>
      <TabsList
        variant="line"
        className="hidden w-[248px] shrink-0 gap-0 self-stretch border-r border-border py-1 pr-3 group-data-vertical/tabs:items-stretch @3xl:flex"
      >
        {groups.map((group) => (
          <div key={group.label} role="presentation" className="flex flex-col gap-0.5">
            <span
              aria-hidden="true"
              className="px-2.5 pt-3.5 pb-1 font-display text-xs font-bold text-muted-foreground"
            >
              {group.label}
            </span>
            {group.pages.map(({ value, label, light, status }) => (
              <TabsTrigger
                key={value}
                value={value}
                className="h-11 justify-between rounded-md px-2.5 text-[15px] font-normal text-muted-foreground after:hidden data-active:bg-card! data-active:font-semibold data-active:text-foreground"
              >
                {label}
                {(light || status) && (
                  <span className="inline-flex items-center gap-1.5 font-sans text-xs font-normal tracking-normal">
                    {status}
                    {light && <StatusLight state={light} />}
                  </span>
                )}
              </TabsTrigger>
            ))}
          </div>
        ))}
      </TabsList>
    </>
  )
}
