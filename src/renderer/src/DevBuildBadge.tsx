/**
 * The "DEV" badge in the header of the dev build (flightdeck-backend robustness/dev-build.md),
 * so a screenshot or a bug report always shows which build it came from. Nothing in a normal
 * build.
 */
import { Badge } from '@/components/ui/badge'

/**
 * @param isDevBuild Defaults to the build flag; a prop so both builds can be tested.
 */
export function DevBuildBadge({ isDevBuild = __WINGLOG_DEV_BUILD__ }: { isDevBuild?: boolean }): React.JSX.Element | null {
  if (!isDevBuild) return null
  return (
    <Badge variant="destructive" title="Dev build: diagnostic logging and flight capture are on" className="shrink-0">
      DEV
    </Badge>
  )
}
