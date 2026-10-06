/**
 * The one sanctioned module-level cache (flightdeck-backend docs/coding-standards.md §4): a value
 * computed on first use and kept for the process, such as a vendored CSV parsed only when a search
 * first needs it. Tests clear every one at once with resetLazyValues, instead of reloading modules.
 */

/** A lazily computed value: call it to get the value, loading it the first time. */
export interface Lazy<T> {
  (): T
}

/** Every lazy value's reset, for resetLazyValues. */
const resets = new Set<() => void>()

/**
 * Wraps a loader so it runs once, on first call, and its result is kept.
 *
 * @param load Computes the value. A thrown error isn't cached: the next call tries again.
 * @returns The lazy value.
 */
export function lazy<T>(load: () => T): Lazy<T> {
  let loaded = false
  let value: T | undefined
  resets.add(() => {
    loaded = false
    value = undefined
  })
  return () => {
    if (!loaded) {
      value = load()
      loaded = true
    }
    return value as T
  }
}

/** Forgets every lazy value, so the next call loads it again. For tests only. */
export function resetLazyValues(): void {
  for (const reset of resets) reset()
}
