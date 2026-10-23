/** The renderer's entry point: mounts App with its theme provider. */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ThemeProvider } from 'next-themes'
import App from './App'
import { ErrorBoundary } from './ErrorBoundary'
import './i18n'
import './index.css'

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <ErrorBoundary name="app">
        <App />
      </ErrorBoundary>
    </ThemeProvider>
  </StrictMode>
)
