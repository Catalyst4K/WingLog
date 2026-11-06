import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { emptyProcedureSelection } from '@shared/procedure-selection'
import { AtcClearanceBackupLine } from './AtcClearanceBackup'
import { AtcClearanceBackupContext, type AtcClearanceBackup } from './atc-clearance-backup-context'

const backup = (over: Partial<AtcClearanceBackup> = {}): AtcClearanceBackup => ({
  clearance: { fields: { starIdent: 'LOGA2H' } } as AtcClearanceBackup['clearance'],
  selection: { ...emptyProcedureSelection(), starIdent: 'SIER7B' },
  onAccept: vi.fn(),
  onDismiss: vi.fn(),
  ...over
})

describe('AtcClearanceBackupLine', () => {
  it('shows nothing where no question is waiting', () => {
    const { container } = render(<AtcClearanceBackupLine />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the waiting question under the instruction, with the same two buttons', async () => {
    const value = backup()
    render(
      <AtcClearanceBackupContext.Provider value={value}>
        <AtcClearanceBackupLine />
      </AtcClearanceBackupContext.Provider>
    )
    expect(screen.getByText('Update procedure from ATC clearance?')).toBeInTheDocument()
    expect(screen.getByText('SIER7B')).toBeInTheDocument()
    expect(screen.getByText('LOGA2H')).toBeInTheDocument()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Update' }))
    expect(value.onAccept).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(value.onDismiss).toHaveBeenCalledTimes(1)
  })
})
