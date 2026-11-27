/**
 * Settings → Devices on a client: the one sim PC it is paired with, its light and state, Forget, what to do when the link is refused,
 * and where phones pair (winglog-backend's docs/plans/devices-page.md, step 3; the canvas's dev-r1-a-list, dark).
 */

import { useTranslation } from 'react-i18next'
import type { HostLinkStatus } from '@shared/ipc'
import { StatusLight } from '@/components/StatusLight'
import { simReachLight } from '@/components/sim-reach'
import { Button } from '@/components/ui/button'
import { winglogApi } from '../data/winglog-api'
import { useConfirm } from '../hooks/use-confirm'
import { asyncHandler } from '../report-error'
import { isRefused } from './host-link-pairing'
import { SettingsCard } from './ui/SettingsCard'

/**
 * The client's list: one row for the sim PC, then its alerts and the line about phones.
 *
 * @param props The link's status, or null before it has been read.
 * @returns The section.
 */
export function SimPcLink(props: { status: HostLinkStatus | null }): React.JSX.Element {
  const { t } = useTranslation()
  const { status } = props
  const state = status?.state ?? 'unpaired'
  const address = state !== 'unpaired' ? status?.address : null
  const [confirm, confirmDialog] = useConfirm()
  // Forget asks first, like Remove on the sim PC's list (decided 2026-11-23).
  const forget = asyncHandler('DevicesPage hostLinkForget', async () => {
    const ok = await confirm({
      title: t('settingsView.devices.forgetTitle'),
      description: t('settingsView.devices.forgetBody'),
      confirmLabel: t('settingsView.devices.forget'),
      cancelLabel: t('settingsView.devices.cancel'),
      destructive: true
    })
    if (ok) await winglogApi().hostLinkForget()
  })
  return (
    <>
      <SettingsCard title={t('settingsView.devices.simPcTitle')}>
        {status && address ? (
          <div className="flex min-h-16 flex-wrap items-center gap-x-4 gap-y-2">
            <StatusLight state={simReachLight(state, status.hostSim ?? undefined)} hollow />
            <div className="flex min-w-0 flex-1 basis-60 flex-col">
              <span className="font-display font-semibold tracking-[-0.01em]">
                {t('settingsView.devices.simPcName')}
              </span>
              <span className="font-mono text-[13px] text-muted-foreground">{address}</span>
            </div>
            <span className="text-sm text-muted-foreground">
              {t(`settingsView.hostLink.states.${state}`)}
            </span>
            <Button type="button" size="sm" variant="outline" onClick={forget}>
              {t('settingsView.devices.forget')}
            </Button>
          </div>
        ) : (
          <p className="m-0 flex items-center text-sm text-muted-foreground">
            {t('settingsView.devices.nothingPaired')}
          </p>
        )}
        {address && status?.sync.problem && (
          <p role="alert" className="m-0 flex items-center text-sm text-destructive">
            {t(`settingsView.hostLink.versionProblem.${status.sync.problem}`)}
          </p>
        )}
        {address && isRefused(state) && (
          <p role="alert" className="m-0 flex items-center text-sm text-destructive">
            {t(`settingsView.hostLink.refused.${state}`)}
          </p>
        )}
        <p className="m-0 flex items-center text-[13px] text-muted-foreground">
          {t('settingsView.devices.phonesPairWithSimPc')}
        </p>
      </SettingsCard>
      {confirmDialog}
    </>
  )
}
