/**
 * "File on VATSIM" / "File on IVAO": opens the network's own filing page from the link SimBrief put in the OFP (winglog-backend
 * docs/plans/vatsim-build.md, Step 3). WingLog files nothing itself: the pilot logs in on the network's page and presses File.
 * Only the network chosen in Settings has a button; with none chosen there is none, as with every VATSIM and IVAO feature (Callum,
 * 2026-10-25: choosing no network is the one switch that hides them all).
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { OnlineNetwork } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { winglogApi } from '../data/winglog-api'
import { asyncHandler, runAsync } from '../report-error'

const NETWORK_NAMES: Record<OnlineNetwork, string> = { vatsim: 'VATSIM', ivao: 'IVAO' }

/**
 * @param props `file` opens the filing page for a network and says whether the OFP had a valid link for it.
 * @returns The chosen network's button, or nothing while no network is chosen (or until the settings are read).
 */
export function PrefileButtons(props: {
  file: (network: OnlineNetwork) => Promise<boolean>
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const [network, setNetwork] = useState<OnlineNetwork | null>(null)

  useEffect(() => {
    runAsync(
      'PrefileButtons settingsGetOnlineNetwork',
      winglogApi()
        .settingsGetOnlineNetwork()
        .then((settings) => setNetwork(settings.network))
    )
  }, [])

  if (!network) return null
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={asyncHandler(`PrefileButtons file ${network}`, async () => {
        const opened = await props.file(network)
        if (!opened) toast.error(t('online.noPrefileLink', { network: NETWORK_NAMES[network] }))
      })}
    >
      {t('online.fileOn', { network: NETWORK_NAMES[network] })}
    </Button>
  )
}
