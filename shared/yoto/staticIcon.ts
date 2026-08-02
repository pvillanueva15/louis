export const STATIC_ICON_SIZE = 16
export const STATIC_ICON_MAX_BYTES = 64 * 1024
export const STATIC_ICON_MAX_SOURCE_BYTES = 10 * 1024 * 1024
export const STATIC_ICON_MAX_SOURCE_DIMENSION = 4096
export const STATIC_ICON_MAX_SOURCE_PIXELS = 16_777_216
export const STATIC_ICON_ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const

export interface StaticIconCrop {
  x: number
  y: number
  size: number
}

export interface StaticIconRenderPlan {
  crop: StaticIconCrop
  outputSize: typeof STATIC_ICON_SIZE
  background: string | null
}

export interface StaticIconSourceDimensions {
  width: number
  height: number
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

export function calculateStaticIconCrop(
  width: number,
  height: number,
  zoom: number,
  panX: number,
  panY: number,
): StaticIconCrop {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('Image dimensions must be positive.')
  }

  const safeZoom = clamp(zoom, 1, 8)
  const size = Math.min(width, height) / safeZoom
  const maxX = width - size
  const maxY = height - size

  return {
    x: maxX * ((clamp(panX, -1, 1) + 1) / 2),
    y: maxY * ((clamp(panY, -1, 1) + 1) / 2),
    size,
  }
}

export function normalizeStaticIconBackground(mode: 'transparent' | 'solid', color: string): string | null {
  if (mode === 'transparent') return null
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error('Choose a valid background color.')
  return color.toLowerCase()
}

export function createStaticIconRenderPlan(
  width: number,
  height: number,
  zoom: number,
  panX: number,
  panY: number,
  backgroundMode: 'transparent' | 'solid',
  backgroundColor: string,
): StaticIconRenderPlan {
  return {
    crop: calculateStaticIconCrop(width, height, zoom, panX, panY),
    outputSize: STATIC_ICON_SIZE,
    background: normalizeStaticIconBackground(backgroundMode, backgroundColor),
  }
}

export function validateStaticIconSource(type: string, bytes: number, width: number, height: number): void {
  if (!(STATIC_ICON_ACCEPTED_TYPES as readonly string[]).includes(type)) {
    throw new Error('Choose a PNG, JPEG, or WebP image.')
  }
  if (!Number.isFinite(bytes) || bytes <= 0 || bytes > STATIC_ICON_MAX_SOURCE_BYTES) {
    throw new Error('Choose an image no larger than 10 MiB.')
  }
  if (
    !Number.isInteger(width)
    || !Number.isInteger(height)
    || width <= 0
    || height <= 0
    || width > STATIC_ICON_MAX_SOURCE_DIMENSION
    || height > STATIC_ICON_MAX_SOURCE_DIMENSION
    || width * height > STATIC_ICON_MAX_SOURCE_PIXELS
  ) {
    throw new Error('Choose an image no larger than 4096×4096 pixels.')
  }
}

export function validateStaticIconSourceHeader(type: string, bytes: Uint8Array): void {
  const isPng = bytes.length >= 8
    && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)
  const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  const isWebp = bytes.length >= 12
    && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF'
    && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'

  if (
    (type === 'image/png' && isPng)
    || (type === 'image/jpeg' && isJpeg)
    || (type === 'image/webp' && isWebp)
  ) return

  throw new Error('The file contents do not match a supported PNG, JPEG, or WebP image.')
}

function parsePngDimensions(bytes: Uint8Array): StaticIconSourceDimensions {
  if (
    bytes.byteLength < 24
    || new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8) !== 13
    || String.fromCharCode(...bytes.slice(12, 16)) !== 'IHDR'
  ) {
    throw new Error('The PNG header is malformed.')
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

function parseJpegDimensions(bytes: Uint8Array): StaticIconSourceDimensions {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const frameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])
  let offset = 2

  while (offset < bytes.byteLength) {
    if (bytes[offset] !== 0xff) throw new Error('The JPEG header is malformed.')
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1
    if (offset >= bytes.byteLength) break

    const marker = bytes[offset++]!
    if (marker === 0xd9 || marker === 0xda) break
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > bytes.byteLength) throw new Error('The JPEG header is truncated.')

    const length = view.getUint16(offset)
    if (length < 2 || offset + length > bytes.byteLength) {
      throw new Error('The JPEG header has a malformed segment.')
    }
    if (frameMarkers.has(marker)) {
      if (length < 7) throw new Error('The JPEG frame header is malformed.')
      return {
        width: view.getUint16(offset + 5),
        height: view.getUint16(offset + 3),
      }
    }
    offset += length
  }

  throw new Error('The JPEG does not contain a supported frame header.')
}

function parseWebpDimensions(bytes: Uint8Array): StaticIconSourceDimensions {
  if (bytes.byteLength < 20) throw new Error('The WebP header is truncated.')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const riffEnd = view.getUint32(4, true) + 8
  if (riffEnd !== bytes.byteLength) throw new Error('The WebP RIFF length is malformed.')

  let offset = 12
  while (offset + 8 <= riffEnd) {
    const type = String.fromCharCode(...bytes.slice(offset, offset + 4))
    const length = view.getUint32(offset + 4, true)
    const dataOffset = offset + 8
    const dataEnd = dataOffset + length
    if (dataEnd < dataOffset || dataEnd > riffEnd) {
      throw new Error('The WebP header has a malformed chunk.')
    }

    if (type === 'VP8X') {
      if (length < 10) throw new Error('The WebP VP8X header is malformed.')
      return {
        width: 1 + bytes[dataOffset + 4]! + (bytes[dataOffset + 5]! << 8) + (bytes[dataOffset + 6]! << 16),
        height: 1 + bytes[dataOffset + 7]! + (bytes[dataOffset + 8]! << 8) + (bytes[dataOffset + 9]! << 16),
      }
    }
    if (type === 'VP8L') {
      if (length < 5 || bytes[dataOffset] !== 0x2f) throw new Error('The WebP VP8L header is malformed.')
      const dimensions = view.getUint32(dataOffset + 1, true)
      return {
        width: 1 + (dimensions & 0x3fff),
        height: 1 + ((dimensions >>> 14) & 0x3fff),
      }
    }
    if (type === 'VP8 ') {
      if (
        length < 10
        || bytes[dataOffset + 3] !== 0x9d
        || bytes[dataOffset + 4] !== 0x01
        || bytes[dataOffset + 5] !== 0x2a
      ) {
        throw new Error('The WebP VP8 header is malformed.')
      }
      return {
        width: view.getUint16(dataOffset + 6, true) & 0x3fff,
        height: view.getUint16(dataOffset + 8, true) & 0x3fff,
      }
    }

    offset = dataEnd + (length % 2)
  }

  throw new Error('The WebP does not contain a supported image header.')
}

export function inspectStaticIconSource(type: string, bytes: Uint8Array): StaticIconSourceDimensions {
  validateStaticIconSourceHeader(type, bytes)
  const dimensions = type === 'image/png'
    ? parsePngDimensions(bytes)
    : type === 'image/jpeg'
      ? parseJpegDimensions(bytes)
      : parseWebpDimensions(bytes)
  validateStaticIconSource(type, bytes.byteLength, dimensions.width, dimensions.height)
  return dimensions
}

export function safeStaticIconFilename(filename: string): string {
  const withoutExtension = filename.trim().replace(/\.[^.]+$/, '')
  const safe = withoutExtension
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)

  return safe || 'icon'
}
