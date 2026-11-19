import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { RowFigure } from './RowFigure'

/** The narrow and wide copies a RowFigure renders. */
function parts(container: HTMLElement): { narrow: Element; wide: Element } {
  return {
    narrow: container.querySelector('[data-layout="narrow"]')!,
    wide: container.querySelector('[data-layout="wide"]')!
  }
}

describe('RowFigure', () => {
  it('puts the locale’s words on whichever side of the figure the locale puts them', () => {
    const after = render(<RowFigure figure="1h 37m" words={(f) => `${f}\u00a0block`} />)
    expect(parts(after.container).narrow.textContent).toBe('1h 37m\u00a0block')
    const before = render(<RowFigure figure="1h 37m" words={(f) => `блок\u00a0${f}`} />)
    expect(parts(before.container).narrow.textContent).toBe('блок\u00a01h 37m')
  })

  it('sets only the figure in the given face on the narrow row, and keeps the wide copy bare', () => {
    const { container } = render(
      <RowFigure figure="T4 A3" words={(f) => `stand\u00a0${f}`} figureClassName="font-mono" />
    )
    const { narrow, wide } = parts(container)
    expect(narrow.querySelector('.font-mono')?.textContent).toBe('T4 A3')
    expect(narrow).toHaveClass('@3xl:hidden')
    expect(wide.textContent).toBe('T4 A3')
    expect(wide).toHaveClass('hidden', '@3xl:inline')
  })
})
