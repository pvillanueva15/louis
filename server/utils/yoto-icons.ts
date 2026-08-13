import { createHash } from 'node:crypto'
import type { Readable } from 'node:stream'
import { inflateSync } from 'node:zlib'
import {
  normalizePersonalIcon,
  normalizePersonalIconList,
  normalizePersonalIconUpload,
  type PersonalIconListResponse,
  type PersonalIconUploadResponse,
} from '../../shared/yoto/iconContract.ts'
import { STATIC_ICON_MAX_BYTES, STATIC_ICON_SIZE } from '../../shared/yoto/staticIcon.ts'

interface YotoIconRequestOptions {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: unknown
  signal?: AbortSignal
}

export type YotoIconRequest = (
  path: string,
  accessToken: string,
  options?: YotoIconRequestOptions,
) => Promise<unknown>

export class YotoIconContractError extends Error {}

export const RECENT_YOTO_TOKEN_VALIDATION_TTL_MS = 5 * 60 * 1_000
export const RECENT_YOTO_TOKEN_VALIDATION_MAX_ENTRIES = 64

const recentYotoTokenValidations = new Map<string, number>()
let validationNow: () => number = Date.now

function accessTokenDigest(accessToken: string): string {
  return createHash('sha256').update(accessToken).digest('hex')
}

function pruneRecentYotoTokenValidations(now: number): void {
  for (const [digest, expiresAt] of recentYotoTokenValidations) {
    if (expiresAt <= now) recentYotoTokenValidations.delete(digest)
  }
}

function recordRecentYotoTokenValidation(accessToken: string): void {
  const now = validationNow()
  pruneRecentYotoTokenValidations(now)
  const digest = accessTokenDigest(accessToken)
  recentYotoTokenValidations.delete(digest)
  recentYotoTokenValidations.set(digest, now + RECENT_YOTO_TOKEN_VALIDATION_TTL_MS)
  while (recentYotoTokenValidations.size > RECENT_YOTO_TOKEN_VALIDATION_MAX_ENTRIES) {
    const oldest = recentYotoTokenValidations.keys().next().value
    if (oldest === undefined) break
    recentYotoTokenValidations.delete(oldest)
  }
}

export function hasRecentYotoTokenValidation(accessToken: string): boolean {
  const now = validationNow()
  pruneRecentYotoTokenValidations(now)
  return recentYotoTokenValidations.has(accessTokenDigest(accessToken))
}

export function resetRecentYotoTokenValidationsForTests(now: () => number = Date.now): void {
  recentYotoTokenValidations.clear()
  validationNow = now
}

export class StaticIconInputError extends Error {
  readonly statusCode: 400 | 413 | 415

  constructor(
    message: string,
    statusCode: 400 | 413 | 415,
  ) {
    super(message)
    this.statusCode = statusCode
  }
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const

function pngChunkChecksum(bytes: Uint8Array, start: number, end: number): number {
  let checksum = 0xffffffff
  for (let index = start; index < end; index += 1) {
    checksum ^= bytes[index]!
    for (let bit = 0; bit < 8; bit += 1) {
      checksum = (checksum >>> 1) ^ (checksum & 1 ? 0xedb88320 : 0)
    }
  }
  return (checksum ^ 0xffffffff) >>> 0
}

function pngPaethPredictor(left: number, up: number, upperLeft: number): number {
  const estimate = left + up - upperLeft
  const leftDistance = Math.abs(estimate - left)
  const upDistance = Math.abs(estimate - up)
  const upperLeftDistance = Math.abs(estimate - upperLeft)
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left
  if (upDistance <= upperLeftDistance) return up
  return upperLeft
}

function normalizeContract<T>(normalize: () => T): T {
  try {
    return normalize()
  }
  catch (error) {
    const message = error instanceof Error ? error.message : 'Yoto returned malformed icon data.'
    throw new YotoIconContractError(message)
  }
}

export function normalizeIconFilename(value: unknown): string {
  if (value === undefined) return 'icon'
  if (typeof value !== 'string') {
    throw new StaticIconInputError('filename must be a safe 1–80 character stem.', 400)
  }

  const filename = value.trim()
  if (filename.length < 1 || filename.length > 80 || !/^[A-Za-z0-9_-]+$/.test(filename)) {
    throw new StaticIconInputError('filename must be a safe 1–80 character stem.', 400)
  }
  return filename
}

export function validateStaticIconContentType(value: string | undefined): void {
  const contentType = value?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'image/png') {
    throw new StaticIconInputError('Content-Type must be image/png.', 415)
  }
}

export async function readBoundedStaticIconBody(
  source: Readable,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = []
    let byteLength = 0

    const cleanup = () => {
      source.off('data', onData)
      source.off('end', onEnd)
      source.off('error', onError)
      source.off('close', onClose)
    }

    const drain = () => {
      const finish = () => {
        source.off('end', finish)
        source.off('close', finish)
        source.off('error', finish)
      }
      source.once('end', finish)
      source.once('close', finish)
      source.once('error', finish)
      source.resume()
    }

    const onData = (chunk: Uint8Array | string) => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      if (byteLength + bytes.byteLength > STATIC_ICON_MAX_BYTES) {
        cleanup()
        chunks.length = 0
        drain()
        reject(new StaticIconInputError('PNG body must be no larger than 64 KiB.', 413))
        return
      }
      byteLength += bytes.byteLength
      chunks.push(bytes)
    }

    const onEnd = () => {
      cleanup()
      const body = new Uint8Array(byteLength)
      let offset = 0
      for (const chunk of chunks) {
        body.set(chunk, offset)
        offset += chunk.byteLength
      }
      resolve(body)
    }

    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }

    const onClose = () => {
      if (source.readableEnded) return
      cleanup()
      reject(new StaticIconInputError('PNG body was interrupted.', 400))
    }

    source.once('end', onEnd)
    source.once('error', onError)
    source.once('close', onClose)
    source.on('data', onData)
  })
}

type PngValidationMode = 'personal' | 'community'
export type StaticIconPngValidator = (bytes: Uint8Array) => void

function validateIconPng(bytes: Uint8Array, mode: PngValidationMode): void {
  if (bytes.byteLength === 0) {
    throw new StaticIconInputError('PNG body is required.', 400)
  }
  if (bytes.byteLength > STATIC_ICON_MAX_BYTES) {
    throw new StaticIconInputError('PNG body must be no larger than 64 KiB.', 413)
  }
  if (bytes.byteLength < PNG_SIGNATURE.length || PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)) {
    throw new StaticIconInputError('Body is not a valid PNG.', 400)
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = PNG_SIGNATURE.length
  let seenIhdr = false
  let seenIdat = false
  let idatEnded = false
  let imageDataLength = 0
  let width = 0
  let height = 0
  let colorType = 0
  let bytesPerPixel = 0
  let paletteEntries = 0
  let seenPalette = false
  let seenTransparency = false
  const imageDataChunks: Uint8Array[] = []

  while (offset < bytes.byteLength) {
    if (bytes.byteLength - offset < 12) {
      throw new StaticIconInputError('PNG has a truncated chunk.', 400)
    }

    const length = view.getUint32(offset)
    const typeOffset = offset + 4
    const dataOffset = typeOffset + 4
    const dataEnd = dataOffset + length
    const chunkEnd = dataEnd + 4
    if (dataEnd < dataOffset || chunkEnd > bytes.byteLength) {
      throw new StaticIconInputError('PNG has a malformed chunk length.', 400)
    }

    const type = String.fromCharCode(
      bytes[typeOffset]!,
      bytes[typeOffset + 1]!,
      bytes[typeOffset + 2]!,
      bytes[typeOffset + 3]!,
    )
    if (!/^[A-Za-z]{4}$/.test(type)) {
      throw new StaticIconInputError('PNG has an invalid chunk type.', 400)
    }
    if (type[2] !== type[2]!.toUpperCase()) {
      throw new StaticIconInputError('PNG has an invalid reserved chunk flag.', 400)
    }
    if (view.getUint32(dataEnd) !== pngChunkChecksum(bytes, typeOffset, dataEnd)) {
      throw new StaticIconInputError('PNG has an invalid chunk checksum.', 400)
    }

    if (!seenIhdr) {
      if (type !== 'IHDR' || length !== 13) {
        throw new StaticIconInputError('PNG is missing a valid IHDR chunk.', 400)
      }
      seenIhdr = true
      width = view.getUint32(dataOffset)
      height = view.getUint32(dataOffset + 4)
      const bitDepth = bytes[dataOffset + 8]
      colorType = bytes[dataOffset + 9]!
      const compression = bytes[dataOffset + 10]
      const filter = bytes[dataOffset + 11]
      const interlace = bytes[dataOffset + 12]
      if (mode === 'personal' && (width !== STATIC_ICON_SIZE || height !== STATIC_ICON_SIZE)) {
        throw new StaticIconInputError('PNG must be exactly 16×16 pixels.', 400)
      }
      if (mode === 'community' && (
        width < 1
        || height < 1
        || width > 256
        || height > 256
        || width * height > 256 * 256
      )) {
        throw new StaticIconInputError('Community PNG dimensions must be between 1×1 and 256×256 pixels.', 400)
      }
      if (compression !== 0 || filter !== 0 || interlace !== 0) {
        throw new StaticIconInputError('PNG must be static and non-interlaced with standard compression and filtering.', 400)
      }
      if (mode === 'personal' && (bitDepth !== 8 || colorType !== 6)) {
        throw new StaticIconInputError('PNG must be a static, non-interlaced 8-bit RGBA image.', 400)
      }
      if (mode === 'community' && (bitDepth !== 8 || (colorType !== 3 && colorType !== 6))) {
        throw new StaticIconInputError('Community PNG must use 8-bit indexed or RGBA color.', 400)
      }
      bytesPerPixel = colorType === 6 ? 4 : 1
    }
    else if (type === 'IHDR') {
      throw new StaticIconInputError('PNG contains more than one IHDR chunk.', 400)
    }
    else if (type === 'PLTE') {
      if (seenPalette || seenIdat || length < 3 || length > 768 || length % 3 !== 0) {
        throw new StaticIconInputError('PNG contains an invalid PLTE chunk.', 400)
      }
      seenPalette = true
      paletteEntries = length / 3
    }
    else if (type === 'tRNS') {
      if (
        seenTransparency
        || seenIdat
        || colorType !== 3
        || !seenPalette
        || length < 1
        || length > paletteEntries
      ) {
        throw new StaticIconInputError('PNG contains an invalid tRNS chunk.', 400)
      }
      seenTransparency = true
    }
    else if (type === 'IDAT') {
      if (idatEnded || (colorType === 3 && !seenPalette)) {
        throw new StaticIconInputError('PNG contains invalid or misplaced image data.', 400)
      }
      seenIdat = true
      imageDataLength += length
      if (length > 0) imageDataChunks.push(bytes.slice(dataOffset, dataEnd))
    }
    else if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') {
      throw new StaticIconInputError('Animated PNGs are not supported.', 400)
    }
    else if (type === 'IEND') {
      if (
        length !== 0
        || !seenIdat
        || imageDataLength === 0
        || (colorType === 3 && !seenPalette)
        || chunkEnd !== bytes.byteLength
      ) {
        throw new StaticIconInputError('PNG is missing image data or a terminal IEND chunk.', 400)
      }
      const compressed = new Uint8Array(imageDataChunks.reduce((total, chunk) => total + chunk.byteLength, 0))
      let compressedOffset = 0
      for (const chunk of imageDataChunks) {
        compressed.set(chunk, compressedOffset)
        compressedOffset += chunk.byteLength
      }

      const scanlineLength = 1 + width * bytesPerPixel
      const expectedLength = height * scanlineLength
      let decoded: Uint8Array
      try {
        decoded = inflateSync(compressed, { maxOutputLength: expectedLength + 1 })
      }
      catch {
        throw new StaticIconInputError('PNG image data could not be decoded.', 400)
      }
      if (decoded.byteLength !== expectedLength) {
        throw new StaticIconInputError('PNG image data has an invalid decoded length.', 400)
      }
      let previousIndexedRow = new Uint8Array(width)
      for (let row = 0; row < height; row += 1) {
        const rowOffset = row * scanlineLength
        const filterType = decoded[rowOffset]!
        if (filterType > 4) {
          throw new StaticIconInputError('PNG image data contains an invalid filter byte.', 400)
        }
        if (colorType !== 3) continue

        const reconstructedRow = new Uint8Array(width)
        for (let column = 0; column < width; column += 1) {
          const filtered = decoded[rowOffset + 1 + column]!
          const left = column === 0 ? 0 : reconstructedRow[column - 1]!
          const up = previousIndexedRow[column]!
          const upperLeft = column === 0 ? 0 : previousIndexedRow[column - 1]!
          let predictor = 0
          if (filterType === 1) predictor = left
          else if (filterType === 2) predictor = up
          else if (filterType === 3) predictor = Math.floor((left + up) / 2)
          else if (filterType === 4) predictor = pngPaethPredictor(left, up, upperLeft)
          const paletteIndex = (filtered + predictor) & 0xff
          if (paletteIndex >= paletteEntries) {
            throw new StaticIconInputError('PNG image data contains an out-of-range palette index.', 400)
          }
          reconstructedRow[column] = paletteIndex
        }
        previousIndexedRow = reconstructedRow
      }
      return
    }
    else {
      if (/^[A-Z]/.test(type)) {
        throw new StaticIconInputError(`PNG contains unsupported critical chunk ${type}.`, 400)
      }
      if (seenIdat) idatEnded = true
    }

    offset = chunkEnd
  }

  throw new StaticIconInputError('PNG is missing image data or a terminal IEND chunk.', 400)
}

export function validateStaticIconPng(bytes: Uint8Array): void {
  validateIconPng(bytes, 'personal')
}

export function validateCommunityIconPng(bytes: Uint8Array): void {
  validateIconPng(bytes, 'community')
}

export async function fetchPersonalIcons(
  accessToken: string,
  request: YotoIconRequest,
): Promise<PersonalIconListResponse> {
  const response = await request('/media/displayIcons/user/me', accessToken)
  const icons = normalizeContract(() => normalizePersonalIconList(response))
  recordRecentYotoTokenValidation(accessToken)
  return icons
}

export async function fetchPersonalIconSourceCandidates(
  accessToken: string,
  request: YotoIconRequest,
): Promise<PersonalIconListResponse> {
  const response = await request('/media/displayIcons/user/me', accessToken)
  const icons = normalizeContract(() => {
    if (
      typeof response !== 'object'
      || response === null
      || !Array.isArray((response as Record<string, unknown>).displayIcons)
    ) {
      throw new Error('Yoto returned a malformed personal icon library.')
    }
    return {
      icons: (response as { displayIcons: unknown[] }).displayIcons.map(normalizePersonalIcon),
    }
  })
  recordRecentYotoTokenValidation(accessToken)
  return icons
}

export async function uploadPersonalIcon(
  bytes: Uint8Array,
  filename: string,
  accessToken: string,
  request: YotoIconRequest,
  options: {
    signal?: AbortSignal
    validator?: StaticIconPngValidator
  } = {},
): Promise<PersonalIconUploadResponse> {
  const validator = options.validator ?? validateStaticIconPng
  validator(bytes)
  const safeFilename = normalizeIconFilename(filename)
  const path = `/media/displayIcons/user/me/upload?autoConvert=true&filename=${encodeURIComponent(safeFilename)}`
  const response = await request(path, accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: bytes,
    signal: options.signal,
  })

  return normalizeContract(() => normalizePersonalIconUpload(response))
}
