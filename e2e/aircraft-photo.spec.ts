import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { expect, test, type Page } from '@playwright/test'
import { launchApp } from './launch-app'

/**
 * The pilot's own photo of an aircraft, through the real app (winglog-backend's docs/plans/aircraft-photos.md): a picture chosen in the
 * aircraft form is shrunk by the main process, saved with the aircraft, shown large on its detail page, and brought back to nothing
 * when removed. The native file dialog can't be driven, so the main process's `dialog.showOpenDialog` is answered with a file made here.
 * `WINGLOG_PHOTO_FILE` points the first test at a real photo instead, for looking at the layout.
 */

const WIDTH_PX = 2400
const HEIGHT_PX = 1600
const SHRUNK_EDGE_PX = 1280
const SCREENSHOT_DIR = join('release', 'sim', 'aircraft-photos')

/**
 * The CRC-32 a PNG chunk ends with.
 *
 * @param bytes The chunk's type and data.
 * @returns The checksum.
 */
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * One PNG chunk.
 *
 * @param type Its four-letter type.
 * @param data Its data.
 * @returns The chunk's bytes.
 */
function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/**
 * A real PNG, sky-blue above and grass-green below, the size of a camera photo unless given another.
 *
 * @param widthPx Its width in pixels.
 * @param heightPx Its height in pixels.
 * @returns The file's bytes.
 */
function samplePng(widthPx = WIDTH_PX, heightPx = HEIGHT_PX): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(widthPx, 0)
  header.writeUInt32BE(heightPx, 4)
  header.set([8, 2, 0, 0, 0], 8) // 8 bits, RGB, no interlace
  const sky = [90, 160, 230]
  const grass = [70, 150, 70]
  const rows = Buffer.alloc((widthPx * 3 + 1) * heightPx)
  for (let y = 0; y < heightPx; y++) {
    const colour = y < heightPx * 0.65 ? sky : grass
    const start = y * (widthPx * 3 + 1)
    for (let x = 0; x < widthPx; x++) rows.set(colour, start + 1 + x * 3)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/**
 * Makes the next file dialog answer with a file.
 *
 * @param app The running app.
 * @param file The file the pilot "chooses".
 */
async function chooseFileInDialog(
  app: Awaited<ReturnType<typeof launchApp>>['app'],
  file: string
): Promise<void> {
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, file)
}

/**
 * Adds an aircraft and opens its edit form.
 *
 * @param window The app window.
 * @param registration The registration.
 */
async function addAircraftAndEdit(window: Page, registration: string): Promise<void> {
  await window.getByRole('button', { name: 'New aircraft' }).click()
  await window.getByRole('textbox').first().fill(registration)
  await window.getByPlaceholder('e.g. A350, Boeing, B77W, or type an ICAO code').fill('A320')
  await window.getByRole('button', { name: 'Save' }).click()
  await window.getByRole('row', { name: new RegExp(registration) }).click()
  await window.getByRole('button', { name: 'Edit' }).click()
}

test('choose your own photo, see it large on the detail page, then remove it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'winglog-photo-e2e-'))
  const file = process.env.WINGLOG_PHOTO_FILE ?? join(dir, 'g-phot.png')
  if (!process.env.WINGLOG_PHOTO_FILE) writeFileSync(file, samplePng())
  const { app, window, cleanup } = await launchApp()
  try {
    await addAircraftAndEdit(window, 'G-PHOT')
    await expect(window.getByRole('button', { name: 'Remove my photo' })).toHaveCount(0)

    // Choose: the form previews the shrunk picture; nothing is saved yet.
    await chooseFileInDialog(app, file)
    await window.getByRole('button', { name: 'Choose your own photo…' }).click()
    const preview = window.locator('form img')
    await expect(preview).toHaveAttribute('src', /^data:image\/jpeg;base64,/)
    await expect(window.getByRole('button', { name: 'Remove my photo' })).toBeVisible()

    // Save: the detail page opens with it, large, edge to edge, and with no airport-data credit.
    await window.getByRole('button', { name: 'Save' }).click()
    const photo = window.getByRole('img', { name: 'G-PHOT A320' })
    await expect(photo).toBeVisible()
    await expect(photo).toHaveAttribute('src', /^data:image\/jpeg;base64,/)
    const naturalWidth = await photo.evaluate((img: HTMLImageElement) => img.naturalWidth)
    expect(naturalWidth).toBeGreaterThan(600)
    expect(naturalWidth).toBeLessThanOrEqual(SHRUNK_EDGE_PX)
    const box = await photo.boundingBox()
    expect(box?.width).toBeGreaterThan(300)
    await expect(window.getByText('Photo via airport-data.com')).toHaveCount(0)
    await window.getByRole('button', { name: 'Back to fleet' }).scrollIntoViewIfNeeded()
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    await window.screenshot({ path: join(SCREENSHOT_DIR, 'detail-large.png') })

    // It survives leaving and coming back (it is in the database, not just on screen).
    await window.getByRole('button', { name: 'Back to fleet' }).click()
    await window.getByRole('row', { name: /G-PHOT/ }).click()
    await expect(window.getByRole('img', { name: 'G-PHOT A320' })).toHaveAttribute(
      'src',
      /^data:image\/jpeg;base64,/
    )

    // Remove: the aircraft has no looked-up photo to fall back to, so the photo is gone.
    await window.getByRole('button', { name: 'Edit' }).click()
    await window.getByRole('button', { name: 'Remove my photo' }).click()
    await window.getByRole('button', { name: 'Save' }).click()
    await expect(window.getByRole('heading', { name: /G-PHOT/ })).toBeVisible()
    await expect(window.getByRole('img', { name: 'G-PHOT A320' })).toHaveCount(0)
  } finally {
    await cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a file that is not a picture is refused with a reason, and nothing changes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'winglog-photo-e2e-'))
  const file = join(dir, 'not-a-picture.png')
  writeFileSync(file, 'this is text, not a PNG')
  const { app, window, cleanup } = await launchApp()
  try {
    await addAircraftAndEdit(window, 'G-NOPE')
    await chooseFileInDialog(app, file)
    await window.getByRole('button', { name: 'Choose your own photo…' }).click()
    await expect(
      window.getByText('WingLog could not read that file as a picture. Choose a JPEG or PNG.')
    ).toBeVisible()
    await expect(window.locator('form img')).toHaveCount(0)
    await expect(window.getByRole('button', { name: 'Remove my photo' })).toHaveCount(0)
  } finally {
    await cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * A Planespotters photo, through the real app: it is shown large ahead of the airport-data ones, credited to its photographer, and
 * the photo and the credit both link to its page, which opens in the system browser, never in the app's own window. The image host is
 * answered here (so the test doesn't depend on the service being up), which also proves the app's CSP lets that host's images load; the
 * system browser is stubbed so nothing opens.
 */
test('a Planespotters photo is shown with its photographer and links to its page through the system browser', async () => {
  const page = 'https://www.planespotters.net/photo/1947470/g-eztk-easyjet-airbus-a320-214?utm_source=api'
  const { app, window, cleanup } = await launchApp()
  try {
    await window.route('https://t.plnspttrs.net/**', (route) =>
      route.fulfill({ status: 200, contentType: 'image/png', body: samplePng() })
    )
    await app.evaluate(({ shell }) => {
      const opened: string[] = []
      Object.assign(globalThis, { openedUrls: opened })
      shell.openExternal = async (url: string) => {
        opened.push(url)
      }
    })
    await window.evaluate(
      (planespottersPageUrl) =>
        (
          globalThis as { winglog?: { aircraftCreate: (aircraft: object) => Promise<unknown> } }
        ).winglog?.aircraftCreate({
          registration: 'G-EZTK',
          icaoType: 'A320',
          planespottersPhotoUrl: 'https://t.plnspttrs.net/00978/1947470_54b1bd86b7_280.jpg',
          planespottersPhotographer: 'John Robert Murdoch',
          planespottersPageUrl
        }),
      page
    )
    await window.getByRole('tab', { name: 'Dispatch' }).click()
    await window.getByRole('tab', { name: 'Fleet' }).click()
    await window.getByRole('row', { name: /G-EZTK/ }).click()

    const photo = window.getByRole('img', { name: 'G-EZTK A320' })
    await expect(photo).toBeVisible()
    expect(await photo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0)
    await expect(window.getByText(/Photo: John Robert Murdoch/)).toBeVisible()
    await expect(window.getByText('Photo via airport-data.com')).toHaveCount(0)

    // Both links go to the photo's page, and a click opens it outside the app.
    const links = window.locator('figure a')
    await expect(links).toHaveCount(2)
    for (const link of await links.all()) await expect(link).toHaveAttribute('href', page)
    const addressBefore = window.url()
    await window.getByRole('link', { name: 'Planespotters.net' }).click()
    await photo.click()
    await expect
      .poll(() => app.evaluate(() => (globalThis as { openedUrls?: string[] }).openedUrls))
      .toEqual([page, page])
    expect(window.url()).toBe(addressBefore)

    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    await window.getByRole('button', { name: 'Back to fleet' }).scrollIntoViewIfNeeded()
    await window.screenshot({ path: join(SCREENSHOT_DIR, 'detail-planespotters.png') })
  } finally {
    await cleanup()
  }
})

/**
 * A photo that is not 3:2 fills the card with its own shape and is never cropped (B-LJE's Planespotters photo is 16:9 and lost its nose
 * and tail to a fixed 3:2 box). The box takes the picture's shape between 6:5 and 3:1; beyond that the whole picture is shown on a band.
 */
for (const shape of [
  { name: 'wide 16:9', width: 1600, height: 900, boxRatio: 16 / 9 },
  { name: 'panoramic 3:1', width: 2400, height: 800, boxRatio: 3 },
  { name: 'tall 2:3', width: 1000, height: 1500, boxRatio: 6 / 5 }
]) {
  test(`a ${shape.name} photo is shown whole, not cropped`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'winglog-photo-e2e-'))
    const file = join(dir, 'shape.png')
    writeFileSync(file, samplePng(shape.width, shape.height))
    const { app, window, cleanup } = await launchApp()
    try {
      await addAircraftAndEdit(window, 'G-SHAP')
      await chooseFileInDialog(app, file)
      await window.getByRole('button', { name: 'Choose your own photo…' }).click()
      await expect(window.locator('form img')).toHaveAttribute('src', /^data:image\/jpeg;base64,/)
      await window.getByRole('button', { name: 'Save' }).click()

      const photo = window.getByRole('img', { name: 'G-SHAP A320' })
      await expect(photo).toBeVisible()
      await expect(photo).toHaveCSS('object-fit', 'contain')
      // The box takes the picture's own shape (so it fills the card edge to edge, uncropped), within 6:5 to 3:1.
      await expect
        .poll(async () => {
          const box = await photo.boundingBox()
          return box ? box.width / box.height : 0
        })
        .toBeCloseTo(shape.boxRatio, 1)
      const box = await photo.boundingBox()
      const card = await window.locator('figure').first().boundingBox()
      expect(box!.width).toBeCloseTo(card!.width, 0)
      mkdirSync(SCREENSHOT_DIR, { recursive: true })
      await window.getByRole('button', { name: 'Back to fleet' }).scrollIntoViewIfNeeded()
      await window.screenshot({ path: join(SCREENSHOT_DIR, `shape-${shape.width}x${shape.height}.png`) })
    } finally {
      await cleanup()
      rmSync(dir, { recursive: true, force: true })
    }
  })
}
