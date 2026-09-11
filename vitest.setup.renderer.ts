import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// Explicit rather than relying on @testing-library/react's own auto-cleanup, which only
// registers itself against a global `afterEach` — this project imports test globals
// explicitly (no `test.globals: true`), so without this, DOM from an earlier test in the
// same file stays mounted and leaks into later queries in that file.
afterEach(() => {
  cleanup()
})
