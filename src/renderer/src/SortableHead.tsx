import { ArrowDown, ArrowUp } from 'lucide-react'
import { TableHead } from '@/components/ui/table'
import type { SortDir } from './hooks/useSortable'

export function SortableHead<TKey extends string>(props: {
  sortKey: TKey
  label: string
  activeKey: TKey
  dir: SortDir
  onSort: (key: TKey) => void
}): React.JSX.Element {
  const active = props.sortKey === props.activeKey
  return (
    <TableHead onClick={() => props.onSort(props.sortKey)} className="cursor-pointer select-none whitespace-nowrap">
      <span className="inline-flex items-center gap-1">
        {props.label}
        {active &&
          (props.dir === 'asc' ? (
            <ArrowUp className="size-3.5 text-muted-foreground" />
          ) : (
            <ArrowDown className="size-3.5 text-muted-foreground" />
          ))}
      </span>
    </TableHead>
  )
}
