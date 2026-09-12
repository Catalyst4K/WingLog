import { ArrowDown, ArrowUp } from 'lucide-react'
import { TableHead } from '@/components/ui/table'
import { cn } from '@/lib/utils'
import type { SortDir } from './hooks/useSortable'

export function SortableHead<TKey extends string>(props: {
  sortKey: TKey
  label: string
  activeKey: TKey
  dir: SortDir
  onSort: (key: TKey) => void
  /** e.g. "text-center" — merged with this component's own layout classes rather than
   *  replacing them. */
  className?: string
}): React.JSX.Element {
  const active = props.sortKey === props.activeKey
  return (
    <TableHead
      onClick={() => props.onSort(props.sortKey)}
      className={cn('cursor-pointer select-none whitespace-nowrap', props.className)}
    >
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
