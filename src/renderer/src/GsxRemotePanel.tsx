import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  GsxRemoteConnectionStatus,
  GsxRemoteMenuState,
  GsxRemotePromptState,
  GsxRemoteServiceStatus,
  GsxRemoteSettings
} from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

const EMPTY_MENU: GsxRemoteMenuState = {
  title: '',
  header: '',
  subtitle: '',
  entries: [],
  icons: [],
  disabled: [],
  layout: ''
}

/**
 * GSX's own live menu, mirrored generically — not a semantic "click this service" UI.
 * GSX's own client (menu.js) "reads NO services array, recognizes NO ids/names"; this does
 * the same, on purpose (docs/gsx-notes.md, flightdeck-backend's docs/decisions.md,
 * 2026-09-21). Provider choice, when GSX asks, is just another snapshot of this same
 * `entries`/`icons`/`disabled` shape — rendering it generically is what makes that work
 * without a special case.
 */
function MenuGrid(props: { menu: GsxRemoteMenuState; onPick: (index: number) => void }): React.JSX.Element {
  const { t } = useTranslation()
  if (props.menu.entries.length === 0) {
    return <p className="text-xs text-muted-foreground">{t('gsxRemotePanel.menuEmpty')}</p>
  }
  return (
    <div className="flex flex-col gap-2">
      {(props.menu.title || props.menu.header) && (
        <p className="text-sm font-medium text-foreground">{props.menu.title || props.menu.header}</p>
      )}
      {props.menu.subtitle && <p className="text-xs text-muted-foreground">{props.menu.subtitle}</p>}
      <div className="grid grid-cols-3 gap-1.5">
        {props.menu.entries.map((entry, index) => (
          <Button
            key={`${index}-${entry}`}
            type="button"
            variant="outline"
            size="sm"
            disabled={props.menu.disabled[index] === true}
            className="h-auto min-h-9 whitespace-normal py-1.5 text-xs"
            onClick={() => props.onPick(index)}
          >
            {props.menu.icons[index] ? (
              <img src={props.menu.icons[index]} alt="" className="size-4 shrink-0" />
            ) : null}
            {entry}
          </Button>
        ))}
      </div>
    </div>
  )
}

function ServicesList(props: { services: GsxRemoteServiceStatus[] }): React.JSX.Element | null {
  const { t } = useTranslation()
  if (props.services.length === 0) return null
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-sm font-medium text-foreground">{t('gsxRemotePanel.services')}</p>
      <ul className="flex flex-col gap-1">
        {props.services.map((service) => (
          <li key={service.id} className="flex items-baseline justify-between gap-2 text-xs">
            <span className="text-foreground">{service.displayName}</span>
            <span className="text-right text-muted-foreground">
              {service.statusText || service.stateText}
              {service.operator ? ` · ${service.operator}` : ''}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function PromptModal(props: {
  prompt: GsxRemotePromptState
  onSubmit: (text: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [text, setText] = useState(props.prompt.default)

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/40 p-3">
      <p className="text-sm font-medium text-foreground">{props.prompt.title}</p>
      {props.prompt.description && <p className="text-xs text-muted-foreground">{props.prompt.description}</p>}
      <Label className="flex flex-col items-start gap-1.5">
        <Input
          type="text"
          value={text}
          maxLength={props.prompt.maxLength || undefined}
          onChange={(e) => setText(e.target.value)}
          autoFocus
        />
      </Label>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={props.onCancel}>
          {t('gsxRemotePanel.cancel')}
        </Button>
        <Button type="button" size="sm" onClick={() => props.onSubmit(text)}>
          {t('gsxRemotePanel.ok')}
        </Button>
      </div>
    </div>
  )
}

export function GsxRemotePanel(): React.JSX.Element {
  const { t } = useTranslation()
  const [settings, setSettings] = useState<GsxRemoteSettings | null>(null)
  const [status, setStatus] = useState<GsxRemoteConnectionStatus>({ state: 'disconnected', lastError: null })
  const [services, setServices] = useState<GsxRemoteServiceStatus[]>([])
  const [menu, setMenu] = useState<GsxRemoteMenuState>(EMPTY_MENU)
  const [prompt, setPrompt] = useState<GsxRemotePromptState | null>(null)

  useEffect(() => {
    window.winglog.settingsGetGsxRemote().then(setSettings)
    window.winglog.gsxRemoteGetStatus().then(setStatus)
    const unsubscribeStatus = window.winglog.onGsxRemoteStatus(setStatus)
    const unsubscribeServices = window.winglog.onGsxRemoteServices(setServices)
    const unsubscribeMenu = window.winglog.onGsxRemoteMenu(setMenu)
    const unsubscribePrompt = window.winglog.onGsxRemotePrompt(setPrompt)
    return () => {
      unsubscribeStatus()
      unsubscribeServices()
      unsubscribeMenu()
      unsubscribePrompt()
    }
  }, [])

  if (settings === null) return <p className="text-xs text-muted-foreground">{t('gsxRemotePanel.loading')}</p>

  if (!settings.enabled || !settings.port) {
    return <p className="text-xs text-muted-foreground">{t('gsxRemotePanel.notConfigured')}</p>
  }

  return (
    <div className="flex flex-col gap-3">
      {status.state !== 'connected' && (
        <p className="text-xs text-muted-foreground">
          {status.state === 'connecting' ? t('gsxRemotePanel.connecting') : t('gsxRemotePanel.disconnected')}
        </p>
      )}
      {prompt && (
        <PromptModal
          prompt={prompt}
          onSubmit={(text) => window.winglog.gsxRemoteSubmitPrompt(prompt.gen, text)}
          onCancel={() => window.winglog.gsxRemoteCancelPrompt(prompt.gen)}
        />
      )}
      <MenuGrid menu={menu} onPick={(index) => window.winglog.gsxRemotePickMenu(index)} />
      <ServicesList services={services} />
    </div>
  )
}
