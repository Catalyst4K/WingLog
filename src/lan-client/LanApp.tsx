/** The second-screen page: pair with the PC once, then the pages: the live map, the flight plan with the weather, ground services and ATC. */

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ImportantGsxMenuDialog } from '@/app/AppDialogs'
import { LiveClientContext } from '@/live/LiveClient'
import { useImportantGsxMenu } from '@/app/use-prompts'
import type { LanConnection } from './lan-connection'
import { lanLiveClient } from './lan-live-client'
import { NavBar, type PageId } from './NavBar'
import { InfoPage } from './InfoPages'
import { TrackPage } from './TrackPage'
import { useLinkState } from './use-link'
import { usePages } from './use-pages'
import { usePcSettings } from './use-pc-settings'

/**
 * @param props The link to the PC.
 * @returns The element.
 */
export function LanApp({ link }: { link: LanConnection }): React.JSX.Element {
  const state = useLinkState(link)
  // Everything below reads the PC's live topics through the link, the same hooks the desktop window runs through Electron's preload.
  const client = useMemo(() => lanLiveClient(link), [link])
  if (state === 'needs-pairing' || state === 'wrong-code') {
    return <PairingScreen wrong={state === 'wrong-code'} onPair={(code) => link.pair(code)} />
  }
  if (state === 'starting') return <Centered>{<Connecting />}</Centered>
  return (
    <LiveClientContext.Provider value={client}>
      <Shell link={link} offline={state === 'offline'} />
    </LiveClientContext.Provider>
  )
}

function Connecting(): React.JSX.Element {
  const { t } = useTranslation()
  return <p className="text-muted-foreground">{t('lanPage.connecting')}</p>
}

function Centered({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="flex h-dvh flex-col items-center justify-center gap-4 p-4">{children}</div>
}

/**
 * @param props Whether the last code was wrong, and what to do with a typed one.
 * @returns The element.
 */
function PairingScreen({
  wrong,
  onPair
}: {
  wrong: boolean
  onPair: (code: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [code, setCode] = useState('')
  return (
    <Centered>
      <form
        className="flex w-full max-w-sm flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          if (code.trim() !== '') onPair(code)
        }}
      >
        <h1 className="font-heading text-2xl font-semibold">{t('lanPage.pairTitle')}</h1>
        <p className="text-sm text-muted-foreground">{t('lanPage.pairHelp')}</p>
        <label className="flex flex-col gap-1.5 text-sm">
          {t('lanPage.codeLabel')}
          <Input
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            className="h-12 text-center font-mono text-2xl tracking-widest"
          />
        </label>
        {wrong && (
          <p role="alert" className="text-sm text-destructive">
            {t('lanPage.wrongCode')}
          </p>
        )}
        <Button type="submit" size="lg" className="h-12" disabled={code.length < 6}>
          {t('lanPage.pair')}
        </Button>
      </form>
    </Centered>
  )
}

/**
 * The signed-in page: the dropped-link warning, the page chosen from the bar below, and the bar. The Track page stays mounted while another
 * is open, so the map keeps its place and zoom.
 *
 * @param props The link, and whether it has dropped.
 * @returns The element.
 */
function Shell({ link, offline }: { link: LanConnection; offline: boolean }): React.JSX.Element {
  const { t } = useTranslation()
  const [page, setPage] = useState<PageId>('track')
  const settings = usePcSettings(link)
  const pages = usePages(settings)
  const shown = pages.some((p) => p.id === page) ? page : 'track'
  // An important GSX menu (pushback direction, fuel amount) interrupts on any page but GSX's own, where it is answered in place.
  const gsxMenu = useImportantGsxMenu(shown === 'gsx')
  return (
    <div className="flex h-dvh flex-col">
      {offline && (
        <p role="status" className="bg-destructive px-4 py-2 text-center text-sm text-white">
          {t('lanPage.offline')}
        </p>
      )}
      <main className="min-h-0 flex-1">
        <div className={shown === 'track' ? 'h-full' : 'hidden'}>
          <TrackPage link={link} />
        </div>
        {shown !== 'track' && (
          <div className="h-full overflow-y-auto">
            <InfoPage page={shown} link={link} settings={settings} />
          </div>
        )}
      </main>
      <NavBar pages={pages} current={shown} onChange={setPage} />
      <ImportantGsxMenuDialog menu={gsxMenu.menu} open={gsxMenu.open} onDismiss={gsxMenu.onDismiss} />
    </div>
  )
}
