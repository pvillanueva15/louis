import type { Readable } from 'node:stream'
import {
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
}

export type YotoIconRequest = (
  path: string,
  accessToken: string,
  options?: YotoIconRequestOptions,
) => Promise<unknown>

export class YotoIconContractError extends Error {}

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

export function validateStaticIconPng(bytes: Uint8Array): void {
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
  let seenImageData = false

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
    if (view.getUint32(dataEnd) !== pngChunkChecksum(bytes, typeOffset, dataEnd)) {
      throw new StaticIconInputError('PNG has an invalid chunk checksum.', 400)
    }

    if (!seenIhdr) {
      if (type !== 'IHDR' || length !== 13) {
        throw new StaticIconInputError('PNG is missing a valid IHDR chunk.', 400)
      }
      seenIhdr = true
      const width = view.getUint32(dataOffset)
      const height = view.getUint32(dataOffset + 4)
      if (width !== STATIC_ICON_SIZE || height !== STATIC_ICON_SIZE) {
        throw new StaticIconInputError('PNG must be exactly 16×16 pixels.', 400)
      }
    }
    else if (type === 'IHDR') {
      throw new StaticIconInputError('PNG contains more than one IHDR chunk.', 400)
    }
    else if (type === 'IDAT') {
      seenImageData ||= length > 0
    }
    else if (type === 'IEND') {
      if (length !== 0 || !seenImageData || chunkEnd !== bytes.byteLength) {
        throw new StaticIconInputError('PNG is missing image data or a terminal IEND chunk.', 400)
      }
      return
    }

    offset = chunkEnd
  }

  throw new StaticIconInputError('PNG is missing image data or a terminal IEND chunk.', 400)
}

export async function fetchPersonalIcons(
  accessToken: string,
  request: YotoIconRequest,
): Promise<PersonalIconListResponse> {
  const response = await request('/media/displayIcons/user/me', accessToken)
  return normalizeContract(() => normalizePersonalIconList(response))
}

export async function uploadPersonalIcon(
  bytes: Uint8Array,
  filename: string,
  accessToken: string,
  request: YotoIconRequest,
): Promise<PersonalIconUploadResponse> {
  validateStaticIconPng(bytes)
  const safeFilename = normalizeIconFilename(filename)
  const path = `/media/displayIcons/user/me/upload?autoConvert=true&filename=${encodeURIComponent(safeFilename)}`
  const response = await request(path, accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: bytes,
  })

  return normalizeContract(() => normalizePersonalIconUpload(response))
}
