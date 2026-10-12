/**
 * Types for the jest-dom matchers (`toBeInTheDocument` and the rest) on vitest's `expect`. @testing-library/jest-dom ships this
 * augmentation, but declares `Assertion` with one type parameter; vitest 5's `Assertion` has two, so its copy no longer merges.
 */
import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers'

declare module 'vitest' {
  /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-empty-object-type, @typescript-eslint/no-unused-vars */
  interface Assertion<R extends void | Promise<void> = void, T = unknown> extends TestingLibraryMatchers<
    any,
    T
  > {}
  interface AsymmetricMatchersContaining extends TestingLibraryMatchers<any, any> {}
  /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-empty-object-type, @typescript-eslint/no-unused-vars */
}
