/** The bar along the bottom of the page: one button per page, each big enough to tap. */

import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

/** The pages the bar can show. */
export type PageId = 'track' | 'dispatch' | 'weather' | 'gsx' | 'beyondatc'

/** One button in the bar. */
export interface PageEntry {
  id: PageId
  label: string
  icon: LucideIcon
}

/**
 * @param props The pages, the one open, and what to do when another is tapped.
 * @returns The element.
 */
export function NavBar(props: {
  pages: PageEntry[]
  current: PageId
  onChange: (page: PageId) => void
}): React.JSX.Element {
  return (
    <nav className="flex border-t border-border bg-card pb-[env(safe-area-inset-bottom)]" aria-label="Pages">
      {props.pages.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          aria-current={props.current === id ? 'page' : undefined}
          onClick={() => props.onChange(id)}
          className={cn(
            'flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-1 text-[11px]',
            props.current === id ? 'font-medium text-primary' : 'text-muted-foreground'
          )}
        >
          <Icon className="size-5" />
          <span className="max-w-full truncate">{label}</span>
        </button>
      ))}
    </nav>
  )
}
