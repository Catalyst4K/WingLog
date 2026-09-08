import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ command }) => {
  // Cloud sync build-time flag (docs/plans/public-release-v1.md, Decision 1) — kept
  // buildable, hidden and disabled by default in what ships publicly. `electron-vite dev`
  // (command === 'serve') is always Callum's own machine, so it stays on there without
  // needing to remember an env var every time; `electron-vite build` — used by both
  // `npm run build`/`package:*` locally and CI's packaging workflow — defaults off unless
  // WINGLOG_CLOUD_SYNC=1 is set, which is how a private build opts back in. A build-time
  // constant rather than a runtime Settings toggle, so a public binary can't have it
  // flipped back on by a user — see src/shared/build-flags.d.ts.
  const cloudSyncEnabled = command === 'serve' || process.env.WINGLOG_CLOUD_SYNC === '1'
  const define = { __WINGLOG_CLOUD_SYNC_ENABLED__: JSON.stringify(cloudSyncEnabled) }

  return {
    main: {
      plugins: [externalizeDepsPlugin()],
      resolve: {
        alias: {
          '@shared': resolve('src/shared')
        }
      },
      define
    },
    preload: {
      plugins: [externalizeDepsPlugin()],
      resolve: {
        alias: {
          '@shared': resolve('src/shared')
        }
      }
    },
    renderer: {
      root: 'src/renderer',
      resolve: {
        alias: {
          '@renderer': resolve('src/renderer/src'),
          '@shared': resolve('src/shared'),
          '@': resolve('src/renderer/src')
        }
      },
      plugins: [react(), tailwindcss()],
      define
    }
  }
})
