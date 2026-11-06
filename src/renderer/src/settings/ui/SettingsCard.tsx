/**
 * The building blocks every Settings card is made of (winglog-backend's docs/plans/settings-layout.md), so the cards cannot drift
 * apart again: one width, one section anatomy, one way to lay out a setting, one on/off control, one status light.
 *
 * v2 (winglog-backend docs/plans/v2-design.md, Part 5): a "card" is no longer a box. It is a heading, a one-line hint and a column of
 * label-and-control rows, divided from the section above by a hairline. The `data-slot` names stay (`card`, `card-content`) because
 * tests and the e2e specs find a section by them.
 */

import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { StatusLight, type LightState } from '@/components/StatusLight'
import { cn } from '@/lib/utils'

/**
 * A Settings section. Its width is fixed here and nowhere else: the page decides how wide sections are, a section never does.
 *
 * @param props The title, an optional status light and description, the body, and an optional footer of actions.
 * @returns The element.
 */
export function SettingsCard(props: {
  title: ReactNode
  status?: ReactNode
  description?: ReactNode
  children?: ReactNode
  footer?: ReactNode
}): React.JSX.Element {
  return (
    <section data-slot="card" className="mt-[26px] flex w-full max-w-[760px] flex-col gap-1 first:mt-0">
      <header className="flex flex-col gap-1">
        <h2 className="m-0 flex items-center justify-between gap-2 text-base font-semibold text-foreground">
          <span>{props.title}</span>
          {props.status}
        </h2>
        {props.description && <p className="text-sm text-muted-foreground">{props.description}</p>}
      </header>
      {props.children !== undefined && (
        <div
          data-slot="card-content"
          className="flex flex-col [&>*]:min-h-14 [&>*]:border-t [&>*]:border-border [&>*]:py-2"
        >
          {props.children}
        </div>
      )}
      {props.footer && <div className="flex justify-end gap-2 pt-2">{props.footer}</div>}
    </section>
  )
}

/**
 * A titled group of rows inside a card (Fleet and Logbook in Data, for example), with actions for the whole group beside its title.
 *
 * @param props The heading, an optional accessible name for the region (when it differs from the heading), actions, and the rows.
 * @returns The element.
 */
export function SettingsSection(props: {
  title: string
  ariaLabel?: string
  action?: ReactNode
  children: ReactNode
}): React.JSX.Element {
  return (
    <section aria-label={props.ariaLabel ?? props.title} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-foreground">{props.title}</h3>
        {props.action && <div className="flex gap-2">{props.action}</div>}
      </div>
      {props.children}
    </section>
  )
}

/**
 * One setting: its label (and what it means) on the left, its control on the right. The control drops under the label when the card
 * is too narrow for both, or always when `stacked` is set (a wide control such as a list of languages or a folder path).
 *
 * @param props The label, an optional visible note, the control, and the id of the control the label belongs to (when it is a field).
 * @returns The element.
 */
export function SettingRow(props: {
  label: string
  note?: string
  controlId?: string
  /** Beside the label: an info popover for a caveat. */
  labelAddOn?: ReactNode
  stacked?: boolean
  /** Marks the label as a live status line (the update check’s result). */
  labelRole?: 'status'
  children: ReactNode
}): React.JSX.Element {
  const labelClass = 'text-[15px] font-normal text-foreground'
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
        <div className="flex items-center gap-1">
          {props.controlId ? (
            <Label htmlFor={props.controlId} className={labelClass}>
              {props.label}
            </Label>
          ) : (
            <span className={labelClass} role={props.labelRole}>
              {props.label}
            </span>
          )}
          {props.labelAddOn}
        </div>
        {props.note && <p className="m-0 text-[13px] leading-snug text-muted-foreground">{props.note}</p>}
      </div>
      <div
        className={cn(
          'flex min-w-0 items-center justify-end gap-1.5',
          props.stacked && 'basis-full justify-start'
        )}
      >
        {props.children}
      </div>
    </div>
  )
}

/**
 * A group of choices joined in one bordered box (the canvas's r3-settings): the chosen one filled with the text colour.
 *
 * @param props The accessible name and the buttons.
 * @returns The element.
 */
export function SegmentedGroup(props: { label: string; children: ReactNode }): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label={props.label}
      className="inline-flex overflow-hidden rounded-md border border-input"
    >
      {props.children}
    </div>
  )
}

/**
 * One choice of a SegmentedGroup.
 *
 * @param props Whether it is the chosen one, whether it is disabled, the click handler and its text; `small` for a control that
 *   sits among other things on a page rather than being the setting of a row.
 * @returns The element.
 */
export function SegmentButton(props: {
  small?: boolean
  pressed: boolean
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="ghost"
      aria-pressed={props.pressed}
      disabled={props.disabled}
      onClick={props.onClick}
      className={cn(
        props.small ? 'h-8 min-w-12 px-2.5 text-[13px]' : 'h-10 min-w-16 px-3 text-sm',
        'rounded-none font-normal',
        props.pressed
          ? 'bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground'
          : 'text-muted-foreground'
      )}
    >
      {props.children}
    </Button>
  )
}

/**
 * The on/off control: a pair of buttons, the pressed one filled. The one way to switch a feature on or off.
 *
 * @param props What it switches, whether it is on, the two button texts and the change handler.
 * @returns The element.
 */
export function OnOffControl(props: {
  label: string
  enabled: boolean
  disabled?: boolean
  onText: string
  offText: string
  onChange: (enabled: boolean) => void
}): React.JSX.Element {
  return (
    <SegmentedGroup label={props.label}>
      {[true, false].map((value) => (
        <SegmentButton
          key={String(value)}
          pressed={props.enabled === value}
          disabled={props.disabled}
          onClick={() => props.onChange(value)}
        >
          {value ? props.onText : props.offText}
        </SegmentButton>
      ))}
    </SegmentedGroup>
  )
}

/**
 * A connection's state, shown the same way in every section's heading: a light and the word. Green connected, amber while it is
 * connecting or not connected, red for an error.
 *
 * @param props The state, and its (translated) text.
 * @returns The light and word.
 */
export function StatusBadge(props: {
  state: 'connected' | 'connecting' | 'disconnected' | 'error'
  label: string
}): React.JSX.Element {
  const light: Record<typeof props.state, LightState> = {
    connected: 'green',
    connecting: 'amber',
    disconnected: 'amber',
    error: 'red'
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
      <StatusLight state={light[props.state]} />
      {props.label}
    </span>
  )
}
