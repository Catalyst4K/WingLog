import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { CUSTOM_PHOTO_MAX_CHARS, CUSTOM_PHOTO_MAX_EDGE_PX, CUSTOM_PHOTO_PREFIX } from '@shared/aircraft-photo'
import { pickAircraftPhoto, preparePhoto, type DecodedPicture } from './aircraft-photo-file'

const { showOpenDialog, createFromBuffer, warn } = vi.hoisted(() => ({
  showOpenDialog: vi.fn(),
  createFromBuffer: vi.fn(),
  warn: vi.fn()
}))

vi.mock('electron', () => ({
  dialog: { showOpenDialog },
  nativeImage: { createFromBuffer }
}))

vi.mock('../logging/logger', () => ({ logger: { warn } }))

/** A picture of a given size that records how it was resized and encoded. */
function fakePicture(
  width: number,
  height: number,
  jpeg = Buffer.from('jpeg-bytes')
): DecodedPicture & {
  resized: { width: number; height: number }[]
  quality: number[]
} {
  const resized: { width: number; height: number }[] = []
  const quality: number[] = []
  const picture = {
    resized,
    quality,
    isEmpty: () => width === 0,
    getSize: () => ({ width, height }),
    resize: (options: { width: number; height: number }) => {
      resized.push({ width: options.width, height: options.height })
      return picture
    },
    toJPEG: (q: number) => {
      quality.push(q)
      return jpeg
    }
  }
  return picture
}

describe('preparePhoto', () => {
  it('shrinks a picture wider than the limit, keeping its shape, and saves it as a JPEG data URL', () => {
    const picture = fakePicture(4000, 3000)
    const result = preparePhoto(Buffer.from('x'), () => picture)
    expect(picture.resized).toEqual([{ width: CUSTOM_PHOTO_MAX_EDGE_PX, height: 960 }])
    expect(picture.quality).toEqual([85])
    expect(result).toEqual({ dataUrl: CUSTOM_PHOTO_PREFIX + Buffer.from('jpeg-bytes').toString('base64') })
  })

  it('shrinks by the longer side, so a tall picture is limited by its height', () => {
    const picture = fakePicture(3000, 4000)
    preparePhoto(Buffer.from('x'), () => picture)
    expect(picture.resized).toEqual([{ width: 960, height: CUSTOM_PHOTO_MAX_EDGE_PX }])
  })

  it('never enlarges a small picture', () => {
    const picture = fakePicture(640, 427)
    expect(preparePhoto(Buffer.from('x'), () => picture)).toHaveProperty('dataUrl')
    expect(picture.resized).toEqual([])
  })

  it('leaves a picture exactly at the limit as it is', () => {
    const picture = fakePicture(CUSTOM_PHOTO_MAX_EDGE_PX, 853)
    preparePhoto(Buffer.from('x'), () => picture)
    expect(picture.resized).toEqual([])
  })

  it('says so when the bytes are not a picture', () => {
    expect(preparePhoto(Buffer.from('not an image'), () => fakePicture(0, 0))).toEqual({
      error: 'WingLog could not read that file as a picture. Choose a JPEG or PNG.'
    })
  })

  it('says so when even the shrunk picture is too big to keep', () => {
    const huge = Buffer.alloc(CUSTOM_PHOTO_MAX_CHARS)
    expect(preparePhoto(Buffer.from('x'), () => fakePicture(100, 100, huge))).toEqual({
      error: 'That picture is too detailed to keep. Try a smaller one.'
    })
  })

  it('decodes with Electron when no decoder is given', () => {
    createFromBuffer.mockReturnValueOnce(fakePicture(100, 100))
    expect(preparePhoto(Buffer.from('x'))).toHaveProperty('dataUrl')
    expect(createFromBuffer).toHaveBeenCalledWith(Buffer.from('x'))
  })
})

describe('pickAircraftPhoto', () => {
  let dir: string
  const window = {} as BrowserWindow

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'winglog-photo-'))
    showOpenDialog.mockReset()
    createFromBuffer.mockReset()
    warn.mockReset()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('answers null when the dialog is cancelled', async () => {
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    expect(await pickAircraftPhoto(window)).toBeNull()
  })

  it('offers pictures only, over the window', async () => {
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    await pickAircraftPhoto(window)
    expect(showOpenDialog).toHaveBeenCalledWith(
      window,
      expect.objectContaining({
        filters: [{ name: 'Pictures', extensions: ['jpg', 'jpeg', 'png'] }],
        properties: ['openFile']
      })
    )
  })

  it('reads the chosen file and answers with the prepared picture', async () => {
    const file = join(dir, 'a320.png')
    writeFileSync(file, 'pretend png bytes')
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [file] })
    createFromBuffer.mockReturnValue(fakePicture(2560, 1440))
    const result = await pickAircraftPhoto(window)
    expect(result).toHaveProperty('dataUrl')
    expect(createFromBuffer).toHaveBeenCalledWith(Buffer.from('pretend png bytes'))
  })

  it('refuses a file over 25 MB without decoding it', async () => {
    const file = join(dir, 'huge.jpg')
    writeFileSync(file, '')
    truncateSync(file, 25 * 1024 * 1024 + 1)
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [file] })
    expect(await pickAircraftPhoto(window)).toEqual({
      error: 'That file is too large to be a photo (the limit is 25 MB)'
    })
    expect(createFromBuffer).not.toHaveBeenCalled()
  })

  it('says so, and logs why, when the file can not be read', async () => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [join(dir, 'missing.jpg')] })
    expect(await pickAircraftPhoto(window)).toEqual({
      error: 'WingLog could not read that file as a picture. Choose a JPEG or PNG.'
    })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not read the chosen picture'))
  })
})
