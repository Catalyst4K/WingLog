import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolveBuildFlags } from './src/shared/resolve-build-flags'

export default defineConfig(({ command }) => {
  // Build-time flags (src/shared/resolve-build-flags.ts): cloud sync is on under
  // `electron-vite dev` and in the dev build, off in every release/packaged build unless a
  // private build sets WINGLOG_CLOUD_SYNC=1. A build-time constant rather than a runtime
  // Settings toggle, so a public binary can't have it flipped on by a user.
  const { cloudSyncEnabled, devBuild } = resolveBuildFlags(command, process.env)
  const define = {
    __WINGLOG_CLOUD_SYNC_ENABLED__: JSON.stringify(cloudSyncEnabled),
    __WINGLOG_DEV_BUILD__: JSON.stringify(devBuild)
  }

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
