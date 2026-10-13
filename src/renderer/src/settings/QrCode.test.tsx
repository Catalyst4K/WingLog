import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { qrMatrix } from '../qr'
import { QrCode } from './QrCode'

describe('QrCode', () => {
  it('is an image with the label a screen reader reads', () => {
    render(<QrCode text="http://192.168.1.136:8765/" label="QR code for the address" />)
    expect(screen.getByRole('img', { name: 'QR code for the address' })).toBeInTheDocument()
  })

  it('is dark on white whatever the theme, with the quiet zone round it, at the size asked', () => {
    const { container } = render(<QrCode text="http://192.168.1.136:8765/" label="x" size={200} />)
    const svg = container.querySelector('svg')!
    const modules = qrMatrix('http://192.168.1.136:8765/').length
    expect(svg.getAttribute('viewBox')).toBe(`0 0 ${modules + 8} ${modules + 8}`)
    expect(svg.getAttribute('width')).toBe('200')
    expect(container.querySelector('rect')?.getAttribute('fill')).toBe('#ffffff')
    expect(container.querySelector('path')?.getAttribute('fill')).toBe('#000000')
  })

  it('draws exactly the dark squares: the path covers as many squares as the matrix has dark ones', () => {
    const text = 'http://10.0.0.5:8790/'
    const { container } = render(<QrCode text={text} label="x" />)
    const dark = qrMatrix(text).flat().filter(Boolean).length
    const covered = [
      ...(container.querySelector('path')?.getAttribute('d') ?? '').matchAll(/h(\d+)v1/g)
    ].reduce((sum, match) => sum + Number(match[1]), 0)
    expect(covered).toBe(dark)
  })

  it('changes when the text changes', () => {
    const { container, rerender } = render(<QrCode text="http://192.168.1.136:8765/" label="x" />)
    const before = container.querySelector('path')?.getAttribute('d')
    rerender(<QrCode text="http://192.168.1.137:8765/" label="x" />)
    expect(container.querySelector('path')?.getAttribute('d')).not.toBe(before)
  })

  it('can be a blurred placeholder that screen readers skip', () => {
    const { container } = render(<QrCode text="http://192.168.1.136:8765/" label="QR" blurred />)
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    expect(container.querySelector('svg')).toHaveClass('blur-md')
  })
})
