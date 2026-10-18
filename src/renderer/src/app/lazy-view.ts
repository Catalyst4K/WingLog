/** Loading a tab's code on demand without the 300 ms Suspense hold on the first visit. */
import { createElement, lazy, type FunctionComponent } from 'react'

/** A view loaded on demand: the component to render, and a way to load it ahead of time. */
export interface LazyView<P extends object> {
  View: (props: P) => React.ReactElement
  /** Loads the view's code; resolves once `View` can render without waiting. */
  preload: () => Promise<void>
}

/**
 * `React.lazy` with one difference: once the code has been loaded, the view renders at once.
 *
 * A plain `lazy` component suspends the first time it renders even when its module is already in memory, and React holds a
 * Suspense fallback on screen for at least 300 ms once it has shown one. So every tab's first visit took 300 ms longer than the
 * second, even after the idle prefetch had loaded the code (measured by `npm run perf:tabs`). Here the prefetch records the
 * loaded component, and `View` uses it directly, so nothing suspends.
 *
 * @param load Dynamic import of the view's component.
 * @returns The view and its preload.
 */
export function lazyView<P extends object>(
  load: () => Promise<{ default: FunctionComponent<P> }>
): LazyView<P> {
  let loaded: FunctionComponent<P> | null = null
  const remember = (module: { default: FunctionComponent<P> }): { default: FunctionComponent<P> } => {
    loaded = module.default
    return module
  }
  const Lazy = lazy(() => load().then(remember))
  return {
    View: (props) => createElement(loaded ?? Lazy, props),
    preload: () => load().then((module) => void remember(module))
  }
}
