/**
 * "File on VATSIM" / "File on IVAO": opens the network's own filing page from the link SimBrief put in the OFP (winglog-backend
 * docs/plans/vatsim-build.md, Step 3). WingLog files nothing itself: the pilot logs in on the network's page and presses File.
 * With a network chosen in Settings only its button shows; with none chosen both do.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { OnlineNetwork } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { winglogApi } from '../data/winglog-api'
import { asyncHandler, runAsync } from '../report-error'

const NETWORK_NAMES: Record<OnlineNetwork, string> = { vatsim: 'VATSIM', ivao: 'IVAO' }
const ALL_NETWORKS: OnlineNetwork[] = ['vatsim', 'ivao']

/**
 * @param props `file` opens the filing page for a network and says whether the OFP had a valid link for it.
 * @returns The buttons, or nothing until the chosen network is known.
 */
export function PrefileButtons(props: {
  file: (network: OnlineNetwork) => Promise<boolean>
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const [networks, setNetworks] = useState<OnlineNetwork[] | null>(null)

  useEffect(() => {
    runAsync(
      'PrefileButtons settingsGetOnlineNetwork',
      winglogApi()
        .settingsGetOnlineNetwork()
        .then((settings) => setNetworks(settings.network ? [settings.network] : ALL_NETWORKS))
    )
  }, [])

  if (!networks) return null
  return (
    <>
      {networks.map((network) => (
        <Button
          key={network}
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
      ))}
    </>
  )
}
