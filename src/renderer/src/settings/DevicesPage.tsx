/**
 * Settings → Devices: everything paired with this computer on one page, with one Add a device (winglog-backend's
 * docs/plans/devices-page.md; the canvas's dev-r1-a-list). On the sim PC: the paired computers and phones, the home-network settings and
 * "This computer". On a client: its sim PC, and "This computer". In a build without multi-device: phones and tablets only.
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { useCapabilities } from '../app/capabilities-context'
import { useHostLinkStatus } from '../app/use-host-link'
import { AddDeviceDialog } from './AddDeviceDialog'
import { DeviceList } from './DeviceList'
import { offersPairing } from './host-link-pairing'
import { DevicesNetwork } from './DevicesNetwork'
import { SimPcLink } from './SimPcLink'
import { ThisComputer } from './ThisComputer'
import { useLanStatus } from './use-lan-status'
import { SettingsPageHeader } from './ui/SettingsCard'

/** The page's sections in one column. */
const COLUMN = 'flex min-w-0 flex-col'

/**
 * The sim PC's part of the page: the paired list and the network section.
 *
 * @param props Whether this build pairs computers.
 * @returns The sections, or nothing until the status is read.
 */
function HostDevices(props: { multiDevice: boolean }): React.JSX.Element | null {
  const [status, setStatus] = useLanStatus(true)
  if (!status) return null
  return (
    <>
      <DeviceList status={status} onStatus={setStatus} />
      <DevicesNetwork status={status} multiDevice={props.multiDevice} onStatus={setStatus} />
    </>
  )
}

/**
 * The Devices page.
 *
 * @param props Whether to open Add a device at once (the first start after "Use another PC's sim"), and what to call once that dialog
 *   has closed, so the request is spent.
 * @returns The element.
 */
export function DevicesPage(props: {
  startAdding?: boolean
  onStartAddingDone?: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { runMode, multiDevice, canHostSim } = useCapabilities()
  const isClient = runMode === 'client'
  const link = useHostLinkStatus(isClient)
  const [addClicked, setAddClicked] = useState(false)
  // The request after "Use another PC's sim" is a client's: it waits until the capabilities say this run is one.
  const [startPending, setStartPending] = useState(props.startAdding ?? false)
  // A client adds only its one sim PC: the button shows while none is paired or the link needs pairing again.
  const canAdd = !isClient || offersPairing(link)
  const adding = addClicked || (startPending && isClient && canAdd)
  const lede = isClient
    ? t('settingsView.devices.ledeClient')
    : multiDevice
      ? t('settingsView.devices.ledeHost')
      : t('settingsView.devices.ledePhones')
  return (
    <div className={COLUMN}>
      <SettingsPageHeader
        title={t('settingsView.categories.devices')}
        lede={lede}
        action={
          canAdd && (
            <Button type="button" onClick={() => setAddClicked(true)}>
              {t('settingsView.devices.add')}
            </Button>
          )
        }
      />
      <div className={`${COLUMN} mt-[26px]`}>
        {isClient ? <SimPcLink status={link} /> : <HostDevices multiDevice={multiDevice} />}
        <ThisComputer />
      </div>
      {adding && (
        <AddDeviceDialog
          isClient={isClient}
          multiDevice={multiDevice}
          canUseAnotherSim={multiDevice && canHostSim && runMode === 'host'}
          onClose={() => {
            setAddClicked(false)
            if (startPending) props.onStartAddingDone?.()
            setStartPending(false)
          }}
        />
      )}
    </div>
  )
}
