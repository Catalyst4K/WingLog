import { render, screen } from '@testing-library/react'
import { Suspense } from 'react'
import { describe, expect, it } from 'vitest'
import { lazyView } from './lazy-view'

const Hello = ({ name }: { name: string }): React.JSX.Element => <p>hello {name}</p>

describe('lazyView', () => {
  it('renders at once, without the fallback, once preloaded', async () => {
    const { View, preload } = lazyView(() => Promise.resolve({ default: Hello }))
    await preload()
    render(
      <Suspense fallback={<p>loading</p>}>
        <View name="pilot" />
      </Suspense>
    )
    expect(screen.getByText('hello pilot')).toBeInTheDocument()
    expect(screen.queryByText('loading')).not.toBeInTheDocument()
  })

  it('shows the fallback, then the view, when it renders before the preload', async () => {
    const { View } = lazyView(() => Promise.resolve({ default: Hello }))
    render(
      <Suspense fallback={<p>loading</p>}>
        <View name="pilot" />
      </Suspense>
    )
    expect(screen.getByText('loading')).toBeInTheDocument()
    expect(await screen.findByText('hello pilot')).toBeInTheDocument()
  })
})
