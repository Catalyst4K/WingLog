/**
 * Choosing the pilot's own picture of an aircraft: the file dialog, the read, and shrinking it to a JPEG data URL small enough to keep
 * in the database (docs/plans/aircraft-photos.md). The renderer never touches the file; it gets back only the finished picture.
 */
import { dialog, nativeImage, type BrowserWindow } from 'electron'
import type { AircraftPhotoPick } from '@shared/ipc'
import {
  CUSTOM_PHOTO_JPEG_QUALITY,
  CUSTOM_PHOTO_MAX_CHARS,
  CUSTOM_PHOTO_MAX_EDGE_PX,
  CUSTOM_PHOTO_MAX_FILE_BYTES,
  CUSTOM_PHOTO_PREFIX
} from '@shared/aircraft-photo'
import { readLimitedFile } from '../db/import-limits'
import { t } from '../i18n'
import { logger } from '../logging/logger'

/** The part of a decoded picture this needs; Electron's NativeImage has all of it. */
export interface DecodedPicture {
  isEmpty: () => boolean
  getSize: () => { width: number; height: number }
  resize: (options: { width: number; height: number; quality: 'best' }) => DecodedPicture
  toJPEG: (quality: number) => Buffer
}

/**
 * Turns a picture file's bytes into the JPEG data URL that is kept: shrunk so its longest side is at most
 * CUSTOM_PHOTO_MAX_EDGE_PX (a smaller picture is never enlarged), saved at CUSTOM_PHOTO_JPEG_QUALITY.
 *
 * @param bytes The file's bytes, a PNG or a JPEG.
 * @param decode Reads the bytes into a picture; Electron's by default.
 * @returns The data URL, or why the bytes can't be used: not a picture, or too detailed to keep.
 */
export function preparePhoto(
  bytes: Buffer,
  decode: (bytes: Buffer) => DecodedPicture = (b) => nativeImage.createFromBuffer(b)
): AircraftPhotoPick {
  const picture = decode(bytes)
  if (picture.isEmpty()) return { error: t('errors.photoUnreadable') }

  const { width, height } = picture.getSize()
  const scale = Math.min(1, CUSTOM_PHOTO_MAX_EDGE_PX / Math.max(width, height))
  const shrunk =
    scale < 1
      ? picture.resize({
          width: Math.round(width * scale),
          height: Math.round(height * scale),
          quality: 'best'
        })
      : picture

  const dataUrl = CUSTOM_PHOTO_PREFIX + shrunk.toJPEG(CUSTOM_PHOTO_JPEG_QUALITY).toString('base64')
  return dataUrl.length > CUSTOM_PHOTO_MAX_CHARS ? { error: t('errors.photoTooDetailed') } : { dataUrl }
}

/**
 * Asks the pilot for a picture of an aircraft and prepares it.
 *
 * @param window The window the open dialog opens over.
 * @returns The picture, or why it can't be used, or null when the pilot cancelled.
 */
export async function pickAircraftPhoto(window: BrowserWindow): Promise<AircraftPhotoPick | null> {
  const { canceled, filePaths } = await dialog.showOpenDialog(window, {
    title: t('dialogs.choosePhoto'),
    filters: [{ name: t('dialogs.pictures'), extensions: ['jpg', 'jpeg', 'png'] }],
    properties: ['openFile']
  })
  if (canceled || filePaths.length === 0) return null

  const tooLarge = t('errors.photoFileTooLarge')
  try {
    return preparePhoto(await readLimitedFile(filePaths[0], CUSTOM_PHOTO_MAX_FILE_BYTES, tooLarge))
  } catch (error) {
    if (error instanceof Error && error.message === tooLarge) return { error: tooLarge }
    logger.warn(`[aircraft-photo] could not read the chosen picture: ${String(error)}`)
    return { error: t('errors.photoUnreadable') }
  }
}
