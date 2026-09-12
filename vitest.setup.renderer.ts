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

// jsdom implements neither the Pointer Events capture methods nor scrollIntoView — Radix's
// Select (and any future Radix primitive built on pointer capture, e.g. Slider) calls
// target.hasPointerCapture/setPointerCapture/releasePointerCapture unconditionally on
// pointerdown, which throws "not a function" under jsdom and crashes the interaction before
// userEvent ever gets a result. No-op stubs are all a test needs: real capture semantics
// don't affect anything these tests assert on.
//
// Accessed off globalThis (rather than the bare `Element` identifier) because this file is
// also picked up by tsconfig.node.json (no "dom" lib) via vitest.config.ts's own include —
// referencing `Element` there resolves to a stray ambient *type* only (no runtime value),
// which tsc rejects as "used as a value here".
const domElement = (globalThis as { Element?: { prototype: Record<string, unknown> } }).Element
if (domElement) {
  if (!domElement.prototype.hasPointerCapture) {
    domElement.prototype.hasPointerCapture = () => false
  }
  if (!domElement.prototype.setPointerCapture) {
    domElement.prototype.setPointerCapture = () => {}
  }
  if (!domElement.prototype.releasePointerCapture) {
    domElement.prototype.releasePointerCapture = () => {}
  }
  if (!domElement.prototype.scrollIntoView) {
    domElement.prototype.scrollIntoView = () => {}
  }
}
