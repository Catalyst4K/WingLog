/** Folder-style tabs: shadcn's Tabs, restyled. */

import * as React from 'react'

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'

/**
 * Folder-style tabs — the tab strip sits directly on top of the content it switches, and the
 * active tab joins that content's top border (winglog-backend docs/plans/beta-ui-polish.md §2). A thin wrapper over the same Radix `Tabs` the rest of the
 * app uses, so keyboard navigation and ARIA come for free; `components/ui/tabs.tsx` is
 * vendored shadcn and stays untouched. One tab pattern app-wide: Logbook's Flights/Landings
 * uses it, and Fleet's Retired table should too.
 */
export const FolderTabs = Tabs
export const FolderTabsContent = TabsContent

/**
 * The row of folder tabs.
 *
 * @param props TabsList's props.
 * @returns The element.
 */
export function FolderTabsList({
  className,
  ...props
}: React.ComponentProps<typeof TabsList>): React.JSX.Element {
  return (
    <TabsList
      variant="line"
      className={cn('h-auto w-full justify-start gap-1 rounded-none border-b border-border p-0', className)}
      {...props}
    />
  )
}

/**
 * One folder tab.
 *
 * @param props TabsTrigger's props.
 * @returns The element.
 */
export function FolderTabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsTrigger>): React.JSX.Element {
  return (
    <TabsTrigger
      className={cn(
        // Sits 1px low so the active tab's background covers the list's bottom border.
        'h-auto flex-none -mb-px rounded-t-md rounded-b-none border border-transparent px-4 py-1.5 after:hidden',
        'data-active:border-border data-active:border-b-background data-active:bg-background',
        className
      )}
      {...props}
    />
  )
}
