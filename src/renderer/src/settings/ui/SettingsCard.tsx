/**
 * The building blocks every Settings card is made of (winglog-backend's docs/plans/settings-layout.md), so the cards cannot drift
 * apart again: one width, one card anatomy, one way to lay out a setting, one on/off control, one status badge.
 */

import type { ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

/**
 * A Settings card. Its width is fixed here and nowhere else: the category panel decides how wide cards are, a card never does.
 *
 * @param props The title, an optional status badge and description, the body, and an optional footer of actions.
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
    <Card className="w-full max-w-2xl">
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2">
          <span>{props.title}</span>
          {props.status}
        </CardTitle>
        {props.description && <CardDescription>{props.description}</CardDescription>}
      </CardHeader>
      {props.children !== undefined && (
        <CardContent className="flex flex-col divide-y divide-border/60 [&>*]:py-3 [&>*:first-child]:pt-0 [&>*:last-child]:pb-0">
          {props.children}
        </CardContent>
      )}
      {props.footer && <div className="flex justify-end gap-2 px-(--card-spacing)">{props.footer}</div>}
    </Card>
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
  const labelClass = 'text-sm text-foreground'
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
        {props.note && <p className="text-xs text-muted-foreground">{props.note}</p>}
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
    <div className="flex gap-1.5" role="group" aria-label={props.label}>
      {[true, false].map((value) => (
        <Button
          key={String(value)}
          type="button"
          size="sm"
          variant={props.enabled === value ? 'default' : 'outline'}
          aria-pressed={props.enabled === value}
          disabled={props.disabled}
          className="min-w-[4.5rem]"
          onClick={() => props.onChange(value)}
        >
          {value ? props.onText : props.offText}
        </Button>
      ))}
    </div>
  )
}

/**
 * A connection's state, shown the same way in every card's header.
 *
 * @param props The state, and its (translated) text.
 * @returns The badge.
 */
export function StatusBadge(props: {
  state: 'connected' | 'connecting' | 'disconnected' | 'error'
  label: string
}): React.JSX.Element {
  const variant = {
    connected: 'default',
    connecting: 'secondary',
    disconnected: 'outline',
    error: 'destructive'
  } as const
  return <Badge variant={variant[props.state]}>{props.label}</Badge>
}
