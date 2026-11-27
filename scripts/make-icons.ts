/**
 * `npm run make-icons`: draws every logo file from the marks in `make-icons-lib.ts` (winglog-backend's
 * docs/plans/logo-v2.md, step 3).
 *
 * Runs inside Electron, which draws each size straight from the SVG (never a resize of a large picture, so 16 px is as
 * crisp as the mark can be) with the app's bundled Golos Text 700. MSFS must not be running while it does: it opens a
 * hidden Electron window.
 *
 * Writes: build/icon.png, build/icon-dark.png, build/icon.ico, build/icon-dark.ico, and the phone's three icons in src/lan-client/public.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow } from 'electron'
import {
  buildIco,
  ICO_SIZES_PX,
  LOGO_DARK_SVG,
  LOGO_FONT_FAMILY,
  LOGO_FULL_BLEED_SVG,
  LOGO_LIGHT_SVG,
  markPage,
  type IcoImage
} from './make-icons-lib.ts'

const ROOT = resolve(import.meta.dirname, '..')
const FONT_FILE = join(ROOT, 'src', 'renderer', 'src', 'fonts', 'golos-text-latin-700-normal.woff2')
const BUILD_DIR = join(ROOT, 'build')
const PHONE_DIR = join(ROOT, 'src', 'lan-client', 'public')
/** The source icon's edge in pixels (the Mac app icon is made from it). */
const SOURCE_SIZE_PX = 1024
/** The phone's manifest icons' edges in pixels. */
const MANIFEST_SMALL_PX = 192
const MANIFEST_LARGE_PX = 512
/** How long to let a hidden window paint before it is captured, in milliseconds. */
const PAINT_WAIT_MS = 400
/** The iPhone Home Screen icon's edge in pixels. */
const APPLE_TOUCH_PX = 180

/**
 * Draws a mark at an exact size, once the Golos font has loaded.
 *
 * @param window The hidden window to draw in, reused for every picture. Windows will not make one smaller than about
 * 32 px, so it is always the largest size and a picture is its top-left corner.
 * @param svg The mark.
 * @param sizePx The picture's edge in pixels.
 * @returns The picture as PNG bytes.
 * @throws When the font did not load or the capture is not the size asked for.
 */
async function render(window: BrowserWindow, svg: string, sizePx: number): Promise<Buffer> {
  const pagePath = join(tmpdir(), `winglog-mark-${randomUUID()}.html`)
  try {
    writeFileSync(pagePath, markPage(svg, pathToFileURL(FONT_FILE).href, sizePx))
    return await capture(window, pagePath, sizePx)
  } finally {
    rmSync(pagePath, { force: true })
  }
}

/**
 * Loads a page in the window and captures its top-left corner once the font has loaded.
 *
 * @param window The hidden window.
 * @param pagePath The page to load.
 * @param sizePx The picture's edge in pixels.
 * @returns The picture as PNG bytes.
 * @throws When the font did not load or the capture is not the size asked for.
 */
async function capture(window: BrowserWindow, pagePath: string, sizePx: number): Promise<Buffer> {
  await window.loadFile(pagePath)
  const family = `700 58px '${LOGO_FONT_FAMILY}'`
  const loaded = (await window.webContents.executeJavaScript(
    `document.fonts.load("${family}").then(() => document.fonts.check("${family}"))`
  )) as boolean
  if (!loaded) throw new Error('Golos Text 700 did not load; the W would be drawn in a fallback font')
  // The window is hidden, so there is no frame to wait for: give it a moment to paint the text it just got the font for.
  await new Promise((resolveWait) => setTimeout(resolveWait, PAINT_WAIT_MS))
  const image = await window.webContents.capturePage({ x: 0, y: 0, width: sizePx, height: sizePx })
  const size = image.getSize()
  if (size.width !== sizePx || size.height !== sizePx) {
    throw new Error(`Asked for ${sizePx} px, captured ${size.width}x${size.height}`)
  }
  return image.toPNG()
}

/**
 * Draws a mark at every .ico size and joins them into one .ico file.
 *
 * @param draw Draws a mark at a size.
 * @param svg The mark.
 * @returns The .ico file's bytes.
 */
async function drawIco(draw: (svg: string, sizePx: number) => Promise<Buffer>, svg: string): Promise<Buffer> {
  const images: IcoImage[] = []
  for (const sizePx of ICO_SIZES_PX) images.push({ sizePx, png: await draw(svg, sizePx) })
  return buildIco(images)
}

/** Writes every logo file. */
async function makeIcons(): Promise<void> {
  const window = new BrowserWindow({
    width: SOURCE_SIZE_PX,
    height: SOURCE_SIZE_PX,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true
  })
  const draw = (svg: string, sizePx: number): Promise<Buffer> => render(window, svg, sizePx)
  // Everything is drawn first and written after, so a failure part way leaves the old files, never a mix of old and new.
  const files = new Map<string, Buffer>()
  files.set(join(BUILD_DIR, 'icon.png'), await draw(LOGO_LIGHT_SVG, SOURCE_SIZE_PX))
  files.set(join(BUILD_DIR, 'icon-dark.png'), await draw(LOGO_DARK_SVG, SOURCE_SIZE_PX))
  files.set(join(BUILD_DIR, 'icon.ico'), await drawIco(draw, LOGO_LIGHT_SVG))
  files.set(join(BUILD_DIR, 'icon-dark.ico'), await drawIco(draw, LOGO_DARK_SVG))
  files.set(join(PHONE_DIR, 'icon-192.png'), await draw(LOGO_LIGHT_SVG, MANIFEST_SMALL_PX))
  files.set(join(PHONE_DIR, 'icon-512.png'), await draw(LOGO_LIGHT_SVG, MANIFEST_LARGE_PX))
  files.set(join(PHONE_DIR, 'apple-touch-icon.png'), await draw(LOGO_FULL_BLEED_SVG, APPLE_TOUCH_PX))
  mkdirSync(BUILD_DIR, { recursive: true })
  for (const [path, bytes] of files) writeFileSync(path, bytes)
}

// Scale factor 1 whatever the display's scaling, so a capture is exactly the size asked for.
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('force-device-scale-factor', '1')
app
  .whenReady()
  .then(makeIcons)
  .then(() => app.exit(0))
  .catch((error: unknown) => {
    process.stderr.write(`make-icons failed: ${String(error)}\n`)
    app.exit(1)
  })
