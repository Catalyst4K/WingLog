import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The second-screen page (src/lan-client/), built to out/lan/ and served by the app's LAN server to a phone or tablet. A separate build
// from the Electron renderer: it shares the renderer's map and styling, but has no preload and no access to the app.
export default defineConfig({
  root: 'src/lan-client',
  base: './',
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src'),
      '@shared': resolve('src/shared'),
      '@': resolve('src/renderer/src')
    }
  },
  define: {
    __WINGLOG_CLOUD_SYNC_ENABLED__: JSON.stringify(false),
    __WINGLOG_DEV_BUILD__: JSON.stringify(false)
  },
  plugins: [react(), tailwindcss()],
  build: {
    outDir: resolve('out/lan'),
    emptyOutDir: true
  }
})
