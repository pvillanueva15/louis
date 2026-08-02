import assert from 'node:assert/strict'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, it } from 'node:test'
import {
  fetchPersonalIcons,
  normalizeIconFilename,
  readBoundedStaticIconBody,
  StaticIconInputError,
  uploadPersonalIcon,
  validateStaticIconContentType,
  validateStaticIconPng,
  YotoIconContractError,
  type YotoIconRequest,
} from './yoto-icons.ts'

const MEDIA_ID = 'A'.repeat(43)

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

function png(width = 16, height = 16): Uint8Array {
  const ihdr = new Uint8Array(13)
  const view = new DataView(ihdr.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  ihdr.set([8, 6, 0, 0, 0], 8)
  return joinBytes(
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', Uint8Array.of(1)),
    pngChunk('IEND'),
  )
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
    assert.throws(() => validateStaticIconPng(new Uint8Array(64 * 1024 + 1)), (error: unknown) => {
      return error instanceof StaticIconInputError && error.statusCode === 413
    })
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

  it('rejects and drains an oversized chunked body without destroying the source', async () => {
    const source = new PassThrough({ autoDestroy: false })
    const drained = once(source, 'end')
    const result = readBoundedStaticIconBody(source)
    source.write(new Uint8Array(64 * 1024))
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
