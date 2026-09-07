import type { WingLogApi } from '@shared/ipc'

declare global {
  interface Window {
    winglog: WingLogApi
  }
}
