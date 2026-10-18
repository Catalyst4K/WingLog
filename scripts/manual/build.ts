/**
 * Builds release/manual/WingLog Manual.pdf from docs/manual (winglog-backend's
 * docs/plans/user-docs-v1-4.md). Runs inside Electron, printing with Chromium's own
 * printToPDF, so there's no PDF library to ship or trust. `npm run manual:build` bundles this
 * with esbuild and runs it with electron; `npm run package:win` does that first, and
 * electron-builder ships the result (extraResources).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow } from 'electron'
import { assembleManual, readChapters } from './assemble'

const root = process.cwd()
const manualDir = join(root, 'docs', 'manual')
const outDir = join(root, 'release', 'manual')
const outFile = join(outDir, 'WingLog Manual.pdf')

async function main(): Promise<void> {
  const version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string })
    .version
  const css = readFileSync(join(manualDir, 'manual.css'), 'utf8')
  const { html, problems } = assembleManual(readChapters(manualDir), manualDir, { version, css })
  if (problems.length > 0) {
    console.error(`Manual has ${problems.length} problem(s):\n${problems.map((p) => `  - ${p}`).join('\n')}`)
    app.exit(1)
    return
  }

  // Written next to the chapters so relative image paths (images/...) resolve.
  const htmlFile = join(manualDir, '.manual.html')
  writeFileSync(htmlFile, html)

  const window = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true } })
  await window.loadURL(pathToFileURL(resolve(htmlFile)).href)
  const pdf = await window.webContents.printToPDF({
    pageSize: 'A4',
    printBackground: true,
    margins: { top: 0.6, bottom: 0.7, left: 0.6, right: 0.6 },
    displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate:
      '<div style="font-size:8px;color:#888;width:100%;text-align:center;font-family:sans-serif">' +
      `WingLog ${version} · <span class="pageNumber"></span> / <span class="totalPages"></span></div>`
  })
  mkdirSync(outDir, { recursive: true })
  writeFileSync(outFile, pdf)
  console.log(`Wrote ${outFile} (${Math.round(pdf.length / 1024)} KB)`)
  app.exit(0)
}

app.whenReady().then(main, (error) => {
  console.error(error)
  app.exit(1)
})
