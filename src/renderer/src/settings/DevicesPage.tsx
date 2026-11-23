/**
 * Settings → Devices: everything paired with this computer on one page, with one Add a device (winglog-backend's
 * docs/plans/devices-page.md; the canvas's dev-r1-a-list). On the sim PC: the paired computers and phones, the home-network settings and
 * "This computer". On a client: its sim PC, and "This computer". In a build without multi-device: phones and tablets only.
 */

import { useTranslation } from 'react-i18next'
import { useCapabilities } from '../app/capabilities-context'
import { useHostLinkStatus } from '../app/use-host-link'
import { DeviceList } from './DeviceList'
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
 * The client's part of the page: its sim PC.
 *
 * @returns The section.
 */
function ClientDevices(): React.JSX.Element {
  const status = useHostLinkStatus(true)
  return <SimPcLink status={status} />
}

/**
 * The Devices page.
 *
 * @returns The element.
 */
export function DevicesPage(): React.JSX.Element {
  const { t } = useTranslation()
  const { runMode, multiDevice } = useCapabilities()
  const isClient = runMode === 'client'
  const lede = isClient
    ? t('settingsView.devices.ledeClient')
    : multiDevice
      ? t('settingsView.devices.ledeHost')
      : t('settingsView.devices.ledePhones')
  return (
    <div className={COLUMN}>
      <SettingsPageHeader title={t('settingsView.categories.devices')} lede={lede} />
      <div className={`${COLUMN} mt-[26px]`}>
        {isClient ? <ClientDevices /> : <HostDevices multiDevice={multiDevice} />}
        <ThisComputer />
      </div>
    </div>
  )
}
