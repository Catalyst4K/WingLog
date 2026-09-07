import { useEffect, useState } from 'react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

/**
 * A free-text input backed by a debounced async search dropdown. `value` is always the
 * live field content (typed or picked) — picking a result just replaces it, it doesn't
 * switch the field into some other "selected" mode. Used for both airport and aircraft
 * type lookups (previously two near-identical implementations).
 */
export function Combobox<T>(props: {
  value: string
  onChange: (value: string) => void
  search: (query: string) => Promise<T[]>
  getOptionKey: (item: T) => string
  getOptionValue: (item: T) => string
  getOptionLabel: (item: T) => string
  /** Fired with the full picked item, alongside onChange — for a field that needs more
   *  than just the text value out of a pick (e.g. also capturing a code for a logo
   *  lookup). Not called for free-typed text, only an actual dropdown pick. */
  onSelectItem?: (item: T) => void
  placeholder?: string
  className?: string
}): React.JSX.Element {
  const [results, setResults] = useState<T[]>([])
  const [searching, setSearching] = useState(false)
  // Drives the search — separate from `props.value` on purpose. `props.value` is
  // controlled by the parent and changes for reasons that shouldn't pop a dropdown open
  // (e.g. autofilling from a related field). Only the input's own onChange (actual
  // typing) sets this, so an external value change never triggers a search. Starts at
  // `null` so the debounce effect doesn't even run until the user types something.
  const [query, setQuery] = useState<string | null>(null)

  useEffect(() => {
    if (query === null) return
    const q = query.trim()
    const timer = setTimeout(() => {
      if (q.length < 2) {
        setResults([])
        return
      }
      setSearching(true)
      props
        .search(q)
        .then(setResults)
        .finally(() => setSearching(false))
    }, 300)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  function handleInput(value: string): void {
    props.onChange(value)
    setQuery(value)
  }

  function handlePick(item: T): void {
    props.onChange(props.getOptionValue(item))
    props.onSelectItem?.(item)
    setQuery(null)
    setResults([])
  }

  return (
    <div className={cn('flex flex-col gap-1', props.className)}>
      <Input
        type="text"
        value={props.value}
        placeholder={props.placeholder}
        onChange={(e) => handleInput(e.target.value)}
      />
      {searching && <span className="text-xs text-muted-foreground">Searching…</span>}
      {results.length > 0 && (
        <ul className="max-h-40 overflow-y-auto rounded-lg border border-border bg-popover text-popover-foreground">
          {results.map((item) => (
            <li key={props.getOptionKey(item)}>
              <button
                type="button"
                onClick={() => handlePick(item)}
                className="block w-full cursor-pointer px-2.5 py-1.5 text-left text-sm hover:bg-muted"
              >
                {props.getOptionLabel(item)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
