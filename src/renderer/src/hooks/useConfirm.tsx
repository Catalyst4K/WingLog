import { useState } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'

interface ConfirmOptions {
  title: string
  description: React.ReactNode
  /** Never a bare "Yes" — says what the button does, e.g. "Delete flight" (docs/plans/
   *  destructive-action-confirmations.md, decision 3). */
  confirmLabel: string
  cancelLabel?: string
  /** Styles the confirm button destructive-red. Leave unset for a non-destructive
   *  confirmation (e.g. "Fly this plan instead?"). */
  destructive?: boolean
}

/**
 * One shared confirmation dialog per component tree, replacing the eight-line
 * AlertDialog-plus-useState scaffolding a call site would otherwise repeat (docs/plans/
 * destructive-action-confirmations.md, step 2). `confirm(...)` resolves `true`/`false`
 * once the user picks an option — await it inline rather than juggling open state by hand.
 */
export function useConfirm(): [(options: ConfirmOptions) => Promise<boolean>, React.JSX.Element] {
  const [pending, setPending] = useState<{ options: ConfirmOptions; resolve: (value: boolean) => void } | null>(
    null
  )

  function confirm(options: ConfirmOptions): Promise<boolean> {
    return new Promise((resolve) => setPending({ options, resolve }))
  }

  function settle(value: boolean): void {
    pending?.resolve(value)
    setPending(null)
  }

  const dialog = (
    <AlertDialog open={pending !== null} onOpenChange={(open) => !open && settle(false)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{pending?.options.title}</AlertDialogTitle>
          <AlertDialogDescription>{pending?.options.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => settle(false)}>{pending?.options.cancelLabel ?? 'Back'}</AlertDialogCancel>
          <AlertDialogAction
            variant={pending?.options.destructive ? 'destructive' : 'default'}
            onClick={() => settle(true)}
          >
            {pending?.options.confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )

  return [confirm, dialog]
}
