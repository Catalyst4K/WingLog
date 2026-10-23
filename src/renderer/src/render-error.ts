/**
 * Where an error caught while drawing (ErrorBoundary) is written. The PC window writes it to main.log through IPC; the second-screen page
 * has no IPC, so its entry point provides a reporter that tells the PC over the link.
 */

import { createContext } from 'react'
import { reportError } from './report-error'

export type RenderErrorReporter = (name: string, error: unknown) => void

export const RenderErrorContext = createContext<RenderErrorReporter>((name, error) =>
  reportError(`render: ${name}`, error)
)
