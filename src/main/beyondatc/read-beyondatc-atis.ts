/**
 * BeyondATC's ATIS for the weather panel and the BeyondATC page (winglog-backend docs/plans/beyondatc-atis.md): read fresh each time, and only
 * while BeyondATC is connected to WingLog.
 */
import type { BeyondAtcAtisList } from '@shared/ipc'
import type { BeyondAtcService } from './BeyondAtcService'

/**
 * @param session The current BeyondATC connection; undefined while BeyondATC is off in Settings.
 * @param hidden True while main says BeyondATC is to stay hidden (the pilot is online and has not asked to keep it): its ATIS follows its
 *   frequencies and prompt, so the two never disagree.
 * @returns 'off' when BeyondATC is not connected or is hidden, 'unavailable' when it did not answer in time, otherwise its ATIS as just sent.
 */
export async function readBeyondAtcAtis(
  session: Pick<BeyondAtcService, 'getStatus' | 'readAtis'> | undefined,
  hidden: boolean
): Promise<BeyondAtcAtisList> {
  if (!session || hidden || session.getStatus().state !== 'connected') return { state: 'off', airports: [] }
  const airports = await session.readAtis()
  return airports === null ? { state: 'unavailable', airports: [] } : { state: 'shown', airports }
}
