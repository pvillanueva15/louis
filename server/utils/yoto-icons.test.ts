import assert from 'node:assert/strict'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, it } from 'node:test'
import { deflateSync } from 'node:zlib'
import { STATIC_ICON_MAX_BYTES } from '../../shared/yoto/staticIcon.ts'
import {
  fetchPersonalIcons,
  hasRecentYotoTokenValidation,
  normalizeIconFilename,
  RECENT_YOTO_TOKEN_VALIDATION_MAX_ENTRIES,
  RECENT_YOTO_TOKEN_VALIDATION_TTL_MS,
  readBoundedStaticIconBody,
  resetRecentYotoTokenValidationsForTests,
  StaticIconInputError,
  uploadPersonalIcon,
  validateCommunityIconPng,
  validateStaticIconContentType,
  validateStaticIconPng,
  YotoIconContractError,
  type YotoIconRequest,
} from './yoto-icons.ts'

const MEDIA_ID = 'A'.repeat(43)

afterEach(() => resetRecentYotoTokenValidationsForTests())

function pngChecksum(bytes: Uint8Array): number {
  let checksum = 0xffffffff
  for (const byte of bytes) {
    checksum ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      checksum = (checksum >>> 1) ^ (checksum & 1 ? 0xedb88320 : 0)
    }
  }
  return (checksum ^ 0xffffffff) >>> 0
}

function joinBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.byteLength
  }
  return result
}

function pngChunk(type: string, data = new Uint8Array()): Uint8Array {
  const chunk = new Uint8Array(12 + data.byteLength)
  const view = new DataView(chunk.buffer)
  view.setUint32(0, data.byteLength)
  chunk.set(new TextEncoder().encode(type), 4)
  chunk.set(data, 8)
  view.setUint32(8 + data.byteLength, pngChecksum(chunk.slice(4, 8 + data.byteLength)))
  return chunk
}

function rgbaScanlines(width = 16, height = 16): Uint8Array {
  return new Uint8Array(height * (1 + width * 4))
}

function indexedPalette(entries: number): Uint8Array {
  return new Uint8Array(entries * 3)
}

function png(
  width = 16,
  height = 16,
  imageData: Uint8Array = deflateSync(rgbaScanlines(width, height)),
): Uint8Array {
  const ihdr = new Uint8Array(13)
  const view = new DataView(ihdr.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  ihdr.set([8, 6, 0, 0, 0], 8)
  return joinBytes(
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', imageData),
    pngChunk('IEND'),
  )
}

function indexedPng(
  width = 16,
  height = 16,
  palette = Uint8Array.of(0, 0, 0, 255, 255, 255),
  transparency: Uint8Array | null = Uint8Array.of(255, 128),
  imageData: Uint8Array = deflateSync(new Uint8Array(height * (1 + width))),
): Uint8Array {
  const ihdr = new Uint8Array(13)
  const view = new DataView(ihdr.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  ihdr.set([8, 3, 0, 0, 0], 8)
  return joinBytes(
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('PLTE', palette),
    ...(transparency ? [pngChunk('tRNS', transparency)] : []),
    pngChunk('IDAT', imageData),
    pngChunk('IEND'),
  )
}

function withIhdrByte(bytes: Uint8Array, index: number, value: number): Uint8Array {
  const changed = bytes.slice()
  changed[index] = value
  new DataView(changed.buffer).setUint32(29, pngChecksum(changed.slice(12, 29)))
  return changed
}

describe('Yoto icon server boundary', () => {
  it('loads and normalizes the exact personal-library endpoint', async () => {
    const calls: Array<{ path: string, token: string, options: unknown }> = []
    const request: YotoIconRequest = async (path, token, options) => {
      calls.push({ path, token, options })
      return {
        displayIcons: [{
          mediaId: MEDIA_ID,
          displayIconId: 'display-icon',
          userId: 'private-user',
        }],
      }
    }

    assert.deepEqual(await fetchPersonalIcons('token', request), {
      icons: [{
        mediaId: MEDIA_ID,
        displayIconId: 'display-icon',
        url: null,
        createdAt: null,
      }],
    })
    assert.deepEqual(calls, [{
      path: '/media/displayIcons/user/me',
      token: 'token',
      options: undefined,
    }])
    assert.equal(hasRecentYotoTokenValidation('token'), true)
    assert.equal(hasRecentYotoTokenValidation('different-token'), false)
  })

  it('does not validate a token when the personal-icon request or response fails', async () => {
    await assert.rejects(
      () => fetchPersonalIcons('transport-failed', async () => Promise.reject(new Error('offline'))),
      /offline/,
    )
    await assert.rejects(
      () => fetchPersonalIcons('contract-failed', async () => ({})),
      YotoIconContractError,
    )
    assert.equal(hasRecentYotoTokenValidation('transport-failed'), false)
    assert.equal(hasRecentYotoTokenValidation('contract-failed'), false)
  })

  it('expires recent Yoto token validation after five minutes', async () => {
    let now = 1_000
    resetRecentYotoTokenValidationsForTests(() => now)
    await fetchPersonalIcons('expiring-token', async () => ({ displayIcons: [] }))
    assert.equal(hasRecentYotoTokenValidation('expiring-token'), true)

    now += RECENT_YOTO_TOKEN_VALIDATION_TTL_MS
    assert.equal(hasRecentYotoTokenValidation('expiring-token'), false)
  })

  it('evicts the oldest digest when the validation cache reaches its bound', async () => {
    for (let index = 0; index <= RECENT_YOTO_TOKEN_VALIDATION_MAX_ENTRIES; index += 1) {
      await fetchPersonalIcons(`token-${index}`, async () => ({ displayIcons: [] }))
    }
    assert.equal(hasRecentYotoTokenValidation('token-0'), false)
    assert.equal(hasRecentYotoTokenValidation('token-1'), true)
    assert.equal(
      hasRecentYotoTokenValidation(`token-${RECENT_YOTO_TOKEN_VALIDATION_MAX_ENTRIES}`),
      true,
    )
  })

  it('forwards raw PNG bytes unchanged to the exact upload URL', async () => {
    const bytes = png()
    let forwardedBody: unknown
    const request: YotoIconRequest = async (path, token, options) => {
      assert.equal(path, '/media/displayIcons/user/me/upload?autoConvert=true&filename=family-icon')
      assert.equal(token, 'token')
      assert.deepEqual(options?.headers, { 'Content-Type': 'image/png' })
      assert.equal(options?.method, 'POST')
      forwardedBody = options?.body
      return {
        displayIcon: {
          mediaId: MEDIA_ID,
          displayIconId: 'display-icon',
          url: 'https://cdn.example/icon.png',
          new: true,
        },
      }
    }

    assert.equal((await uploadPersonalIcon(bytes, 'family-icon', 'token', request)).disposition, 'created')
    assert.equal(forwardedBody, bytes)
  })

  it('normalizes the documented duplicate upload response', async () => {
    const result = await uploadPersonalIcon(png(), 'icon', 'token', async () => ({
      displayIcon: {
        mediaId: MEDIA_ID,
        _id: 'existing-icon',
        url: {},
      },
    }))

    assert.deepEqual(result, {
      icon: {
        mediaId: MEDIA_ID,
        displayIconId: 'existing-icon',
        url: null,
        createdAt: null,
      },
      disposition: 'existing',
    })
  })

  it('rejects malformed successful Yoto responses', async () => {
    await assert.rejects(
      () => fetchPersonalIcons('token', async () => ({})),
      YotoIconContractError,
    )
    await assert.rejects(
      () => uploadPersonalIcon(png(), 'icon', 'token', async () => ({ ok: true })),
      YotoIconContractError,
    )
  })

  it('propagates upstream request failures unchanged', async () => {
    const upstreamError = { statusCode: 429, message: 'rate limited' }
    await assert.rejects(
      () => fetchPersonalIcons('token', async () => Promise.reject(upstreamError)),
      error => error === upstreamError,
    )
  })

  it('validates PNG structure, dimensions, and size', () => {
    assert.doesNotThrow(() => validateStaticIconPng(png()))
    assert.throws(() => validateStaticIconPng(new Uint8Array()), (error: unknown) => {
      return error instanceof StaticIconInputError && error.statusCode === 400
    })
    assert.throws(() => validateStaticIconPng(new Uint8Array(33)), /valid PNG/)

    const missingIhdr = png()
    missingIhdr[12] = 0
    assert.throws(() => validateStaticIconPng(missingIhdr), /chunk type/)
    assert.throws(() => validateStaticIconPng(png(32, 16)), /exactly 16×16/)
    assert.throws(() => validateStaticIconPng(new Uint8Array(STATIC_ICON_MAX_BYTES + 1)), (error: unknown) => {
      return error instanceof StaticIconInputError && error.statusCode === 413
    })

    const indexed = png()
    indexed[25] = 3
    new DataView(indexed.buffer).setUint32(29, pngChecksum(indexed.slice(12, 29)))
    assert.throws(() => validateStaticIconPng(indexed), /8-bit RGBA/)

    const animated = joinBytes(
      png().slice(0, -12),
      pngChunk('acTL', new Uint8Array(8)),
      pngChunk('IEND'),
    )
    assert.throws(() => validateStaticIconPng(animated), /Animated PNGs/)
  })

  it('accepts live community indexed and converted-size RGBA shapes while personal upload stays strict', async () => {
    const indexed = indexedPng()
    const rgba128 = png(128, 128)
    assert.doesNotThrow(() => validateCommunityIconPng(indexed))
    assert.doesNotThrow(() => validateCommunityIconPng(rgba128))
    assert.throws(() => validateStaticIconPng(indexed), /8-bit RGBA/)
    assert.throws(() => validateStaticIconPng(rgba128), /exactly 16×16/)

    let requests = 0
    await assert.rejects(
      () => uploadPersonalIcon(indexed, 'indexed', 'token', async () => {
        requests += 1
        return {}
      }),
      /8-bit RGBA/,
    )
    await assert.rejects(
      () => uploadPersonalIcon(rgba128, 'large', 'token', async () => {
        requests += 1
        return {}
      }),
      /exactly 16×16/,
    )
    assert.equal(requests, 0)
  })

  it('rejects an unfiltered indexed pixel outside the declared palette', () => {
    const scanlines = Uint8Array.of(0, 0, 2)
    assert.throws(
      () => validateCommunityIconPng(indexedPng(2, 1, indexedPalette(2), null, deflateSync(scanlines))),
      /out-of-range palette index/,
    )
  })

  it('rejects a nonzero-filtered pixel that reconstructs outside the declared palette', () => {
    const scanlines = Uint8Array.of(1, 1, 1)
    assert.throws(
      () => validateCommunityIconPng(indexedPng(2, 1, indexedPalette(2), null, deflateSync(scanlines))),
      /out-of-range palette index/,
    )
  })

  it('accepts valid indexed rows using filters 0-4 and prior-row predictors', () => {
    // Reconstructs [0,1,2], [0,1,2], [1,2,3], [1,2,3], and [2,3,1].
    const scanlines = Uint8Array.of(
      0, 0, 1, 2,
      1, 0, 1, 1,
      2, 1, 1, 1,
      3, 1, 1, 1,
      4, 1, 1, 254,
    )
    assert.doesNotThrow(
      () => validateCommunityIconPng(indexedPng(3, 5, indexedPalette(4), null, deflateSync(scanlines))),
    )
  })

  it('rejects malformed or unsupported community PNG structures and image data', () => {
    assert.throws(
      () => validateCommunityIconPng(indexedPng(16, 16, Uint8Array.of(0, 0))),
      /PLTE/,
    )
    assert.throws(
      () => validateCommunityIconPng(indexedPng(16, 16, Uint8Array.of(0, 0, 0), Uint8Array.of(255, 0))),
      /tRNS/,
    )
    assert.throws(() => validateCommunityIconPng(png(257, 1)), /between 1×1 and 256×256/)
    assert.throws(
      () => validateCommunityIconPng(png(16, 16, Uint8Array.of(1))),
      /could not be decoded/,
    )
    assert.throws(
      () => validateCommunityIconPng(png(16, 16, deflateSync(Uint8Array.of(0)))),
      /invalid decoded length/,
    )

    const invalidFilter = rgbaScanlines()
    invalidFilter[0] = 5
    assert.throws(
      () => validateCommunityIconPng(png(16, 16, deflateSync(invalidFilter))),
      /invalid filter byte/,
    )

    const animated = joinBytes(
      png().slice(0, -12),
      pngChunk('acTL', new Uint8Array(8)),
      pngChunk('IEND'),
    )
    assert.throws(() => validateCommunityIconPng(animated), /Animated PNGs/)
    assert.throws(() => validateCommunityIconPng(withIhdrByte(png(), 24, 16)), /8-bit indexed or RGBA/)
    assert.throws(() => validateCommunityIconPng(withIhdrByte(png(), 25, 2)), /8-bit indexed or RGBA/)
    assert.throws(() => validateCommunityIconPng(withIhdrByte(png(), 28, 1)), /non-interlaced/)
  })

  it('rejects truncated and malformed PNG chunk sequences', () => {
    assert.throws(() => validateStaticIconPng(png().slice(0, 24)), /malformed chunk length/)

    const missingIend = png().slice(0, -12)
    assert.throws(() => validateStaticIconPng(missingIend), /terminal IEND/)

    const badChecksum = png()
    badChecksum[20] ^= 1
    assert.throws(() => validateStaticIconPng(badChecksum), /chunk checksum/)

    const badLength = png()
    new DataView(badLength.buffer).setUint32(8, 0xffffffff)
    assert.throws(() => validateStaticIconPng(badLength), /malformed chunk length/)

    assert.throws(
      () => validateStaticIconPng(joinBytes(png(), Uint8Array.of(0))),
      /terminal IEND/,
    )
  })

  it('requires decodable RGBA scanlines with exact length and valid filters', () => {
    assert.throws(() => validateStaticIconPng(png(16, 16, Uint8Array.of(1))), /could not be decoded/)
    assert.throws(
      () => validateStaticIconPng(png(16, 16, deflateSync(Uint8Array.of(0)))),
      /invalid decoded length/,
    )

    const invalidFilter = rgbaScanlines()
    invalidFilter[0] = 5
    assert.throws(
      () => validateStaticIconPng(png(16, 16, deflateSync(invalidFilter))),
      /invalid filter byte/,
    )
  })

  it('rejects and drains an oversized chunked body without destroying the source', async () => {
    const source = new PassThrough({ autoDestroy: false })
    const drained = once(source, 'end')
    const result = readBoundedStaticIconBody(source)
    source.write(new Uint8Array(STATIC_ICON_MAX_BYTES))
    source.write(Uint8Array.of(1))
    source.end(Uint8Array.of(2))

    await assert.rejects(() => result, (error: unknown) => {
      return error instanceof StaticIconInputError && error.statusCode === 413
    })
    await drained
    assert.equal(source.destroyed, false)
    assert.equal(source.readableLength, 0)
  })

  it('accepts only the raw PNG content type', () => {
    assert.doesNotThrow(() => validateStaticIconContentType('image/png'))
    assert.doesNotThrow(() => validateStaticIconContentType('image/png; charset=binary'))
    assert.throws(() => validateStaticIconContentType('image/jpeg'), (error: unknown) => {
      return error instanceof StaticIconInputError && error.statusCode === 415
    })
    assert.throws(() => validateStaticIconContentType(undefined), /Content-Type must be image\/png/)
  })

  it('accepts only bounded safe filename stems', () => {
    assert.equal(normalizeIconFilename(undefined), 'icon')
    assert.equal(normalizeIconFilename(' family_icon-2 '), 'family_icon-2')
    assert.throws(() => normalizeIconFilename('../icon'), /safe 1–80 character stem/)
    assert.throws(() => normalizeIconFilename(''), /safe 1–80 character stem/)
    assert.throws(() => normalizeIconFilename('a'.repeat(81)), /safe 1–80 character stem/)
  })
})
