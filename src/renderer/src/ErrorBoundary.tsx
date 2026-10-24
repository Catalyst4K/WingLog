/**
 * Keeps an error thrown while drawing one part of a page (or an effect in it) from blanking the whole page: that part shows a message
 * and a Reload button, the rest carries on, and the error is written to the log (render-error.ts).
 */

import { Component, type ErrorInfo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { RenderErrorContext } from './render-error'

interface Props {
  /** Which part of the page this guards, for the log ("track", "map"). */
  name: string
  /** When this changes the guarded part is drawn again: moving to another page clears the failure of the one left. */
  resetKey?: string
  children: ReactNode
}

interface State {
  failed: boolean
  seenResetKey: string | undefined
}

/**
 * @returns The message shown in place of a part that failed to draw.
 */
function Failed(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div
      role="alert"
      className="flex h-full min-h-32 flex-col items-center justify-center gap-3 p-6 text-center"
    >
      <p className="text-sm text-muted-foreground">{t('errorBoundary.message')}</p>
      <Button variant="outline" onClick={() => window.location.reload()}>
        {t('errorBoundary.reload')}
      </Button>
    </div>
  )
}

/** Guards one part of a page: see the file header. */
export class ErrorBoundary extends Component<Props, State> {
  static contextType = RenderErrorContext
  declare context: React.ContextType<typeof RenderErrorContext>
  state: State = { failed: false, seenResetKey: this.props.resetKey }

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true }
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey === state.seenResetKey ? null : { failed: false, seenResetKey: props.resetKey }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const message = error instanceof Error ? error.message : String(error)
    const where = info.componentStack?.trim().split(String.fromCharCode(10), 1)[0]?.trim()
    try {
      this.context(this.props.name, new Error(where ? message + ' ' + where : message))
    } catch {
      // The reporter failed: nothing left to tell.
    }
  }

  render(): ReactNode {
    return this.state.failed ? <Failed /> : this.props.children
  }
}
