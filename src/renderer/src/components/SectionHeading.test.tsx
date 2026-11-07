import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SectionHeading } from './SectionHeading'
import { PlanMark } from './PlanMark'

describe('SectionHeading', () => {
  it('opens a section with a 3 px rule in the text colour, the title in Golos and something quiet on the right', () => {
    render(<SectionHeading title="Fuel, planned against actual" aside="96 % of plan" />)
    const heading = screen.getByRole('heading', { name: 'Fuel, planned against actual', level: 2 })
    expect(heading).toHaveClass('font-display', 'font-bold')
    expect(heading.parentElement).toHaveClass('border-t-[3px]', 'border-foreground')
    expect(screen.getByText('96 % of plan')).toHaveClass('text-muted-foreground')
  })

  it('is a level 3 heading inside a page that has its own, and shows no aside when there is none', () => {
    const { container } = render(<SectionHeading level={3} title="Route" />)
    expect(screen.getByRole('heading', { name: 'Route', level: 3 })).toBeInTheDocument()
    expect(container.querySelectorAll('span')).toHaveLength(0)
  })
})

describe('PlanMark', () => {
  it('shows plan text as plain text after the plan’s rule, never in the plan’s colour', () => {
    render(<PlanMark>ADLA1T · LOGA2H · ILS 27R</PlanMark>)
    const text = screen.getByText('ADLA1T · LOGA2H · ILS 27R')
    expect(text).toHaveClass('font-mono')
    expect(text).not.toHaveClass('text-plan')
    expect(text.previousElementSibling).toHaveClass('bg-plan', 'w-[3px]')
  })
})
