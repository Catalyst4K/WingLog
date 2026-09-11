import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Table, TableHeader, TableRow } from '@/components/ui/table'
import { SortableHead } from './SortableHead'

describe('SortableHead', () => {
  it('shows no sort arrow for a column that is not the active sort key', () => {
    render(
      <Table>
        <TableHeader>
          <TableRow>
            <SortableHead sortKey="name" label="Name" activeKey="age" dir="asc" onSort={vi.fn()} />
          </TableRow>
        </TableHeader>
      </Table>
    )
    expect(screen.getByText('Name')).toBeInTheDocument()
    expect(document.querySelector('svg')).toBeNull()
  })

  it('shows an ascending arrow for the active column, sorted ascending', () => {
    const { container } = render(
      <Table>
        <TableHeader>
          <TableRow>
            <SortableHead sortKey="name" label="Name" activeKey="name" dir="asc" onSort={vi.fn()} />
          </TableRow>
        </TableHeader>
      </Table>
    )
    expect(container.querySelector('svg')).toBeInTheDocument()
  })

  it('calls onSort with its own key when clicked', async () => {
    const onSort = vi.fn()
    const user = userEvent.setup()
    render(
      <Table>
        <TableHeader>
          <TableRow>
            <SortableHead sortKey="name" label="Name" activeKey="age" dir="asc" onSort={onSort} />
          </TableRow>
        </TableHeader>
      </Table>
    )

    await user.click(screen.getByText('Name'))

    expect(onSort).toHaveBeenCalledWith('name')
  })
})
