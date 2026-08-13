import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { deflateSync } from 'node:zlib'
import { STATIC_ICON_MAX_BYTES } from '../../shared/yoto/staticIcon.ts'
import {
  createPersonalIconSourceService,
  PersonalIconSourceError,
} from './personal-icon-source.ts'

const DISPLAY_ICON_ID = 'display-icon'
const MEDIA_ID = 'A'.repeat(43)
const SOURCE_URL = `https://media-secure-v2.api.yotoplay.com/icons/${MEDIA_ID}.png`

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

function png(): Uint8Array {
  const ihdr = new Uint8Array(13)
  const view = new DataView(ihdr.buffer)
  view.setUint32(0, 16)
  view.setUint32(4, 16)
  ihdr.set([8, 6, 0, 0, 0], 8)
  return joinBytes(
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(new Uint8Array(16 * 65))),
    pngChunk('IEND'),
  )
}

function response(
  bytes = png(),
  options: { status?: number, url?: string, redirected?: boolean, type?: string, length?: string | null } = {},
) {
  return {
    status: options.status ?? 200,
    url: options.url ?? SOURCE_URL,
    redirected: options.redirected ?? false,
    headers: {
      get(name: string) {
        if (name.toLowerCase() === 'content-type') return options.type ?? 'image/png'
        if (name.toLowerCase() === 'content-length') return options.length === undefined
          ? String(bytes.byteLength)
          : options.length
        return null
      },
    },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    }),
  }
}

function library(url: string | null = SOURCE_URL) {
  return async () => ({
    icons: [{ displayIconId: DISPLAY_ICON_ID, mediaId: MEDIA_ID, url, createdAt: null }],
  })
}

describe('Personal Icon Source service', () => {
  it('refetches the authoritative identity pair and returns strict PNG bytes from the fixed origin', async () => {
    const calls: Array<{ url: string, options: unknown }> = []
    const service = createPersonalIconSourceService({
      fetch: async (url, options) => {
        calls.push({ url, options })
        return response()
      },
    })

    const result = await service.load({ displayIconId: DISPLAY_ICON_ID, mediaId: MEDIA_ID }, library())

    assert.deepEqual(result.bytes, png())
    assert.equal(result.filename, `personal-icon-${MEDIA_ID.slice(0, 12)}.png`)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.url, SOURCE_URL)
    assert.deepEqual(Object.keys(calls[0]!.options as object).sort(), ['redirect', 'signal'])
    assert.equal((calls[0]!.options as { redirect: string }).redirect, 'manual')
  })

  it('rejects malformed identity before listing or fetching assets', async () => {
    let listCalls = 0
    let fetchCalls = 0
    const service = createPersonalIconSourceService({ fetch: async () => {
      fetchCalls += 1
      return response()
    } })

    for (const identity of [
      { displayIconId: 'bad\nvalue', mediaId: MEDIA_ID, url: SOURCE_URL },
      { displayIconId: ` ${DISPLAY_ICON_ID}`, mediaId: MEDIA_ID },
    ]) {
      await assert.rejects(
        () => service.load(identity, async () => {
          listCalls += 1
          return { icons: [] }
        }),
        (error: unknown) => error instanceof PersonalIconSourceError && error.statusCode === 400,
      )
    }
    assert.equal(listCalls, 0)
    assert.equal(fetchCalls, 0)
  })

  it('rejects stale, mismatched, duplicate, and URL-less pairs before fetching assets', async () => {
    let fetchCalls = 0
    const service = createPersonalIconSourceService({ fetch: async () => {
      fetchCalls += 1
      return response()
    } })
    const identity = { displayIconId: DISPLAY_ICON_ID, mediaId: MEDIA_ID }
    const unavailable = (icons: Awaited<ReturnType<ReturnType<typeof library>>>['icons']) => async () => ({ icons })

    for (const icons of [
      [],
      [{ displayIconId: DISPLAY_ICON_ID, mediaId: 'B'.repeat(43), url: SOURCE_URL, createdAt: null }],
      [
        { displayIconId: DISPLAY_ICON_ID, mediaId: MEDIA_ID, url: SOURCE_URL, createdAt: null },
        { displayIconId: DISPLAY_ICON_ID, mediaId: MEDIA_ID, url: SOURCE_URL, createdAt: null },
      ],
      [{ displayIconId: DISPLAY_ICON_ID, mediaId: MEDIA_ID, url: null, createdAt: null }],
    ]) {
      await assert.rejects(
        () => service.load(identity, unavailable(icons)),
        (error: unknown) => error instanceof PersonalIconSourceError && error.code === 'unavailable',
      )
    }
    assert.equal(fetchCalls, 0)
  })

  it('fails closed for any source URL outside the exact accepted production origin', async () => {
    let fetchCalls = 0
    const service = createPersonalIconSourceService({ fetch: async () => {
      fetchCalls += 1
      return response()
    } })

    for (const url of [
      'http://media-secure-v2.api.yotoplay.com/icon.png',
      'https://user@media-secure-v2.api.yotoplay.com/icon.png',
      'https://media-secure-v2.api.yotoplay.com:444/icon.png',
      'https://media-secure.api.yotoplay.com/icon.png',
    ]) {
      await assert.rejects(
        () => service.load({ displayIconId: DISPLAY_ICON_ID, mediaId: MEDIA_ID }, library(url)),
        (error: unknown) => error instanceof PersonalIconSourceError && error.code === 'unsupported',
      )
    }
    assert.equal(fetchCalls, 0)
  })

  it('accepts parameterized PNG media types case-insensitively', async () => {
    const service = createPersonalIconSourceService({
      fetch: async () => response(png(), { type: 'Image/PNG; charset=binary' }),
    })

    const result = await service.load(
      { displayIconId: DISPLAY_ICON_ID, mediaId: MEDIA_ID },
      library(),
    )

    assert.deepEqual(result.bytes, png())
  })

  it('rejects redirects, non-200 status, non-PNG media types, declared overflow, streamed overflow, and invalid PNG', async () => {
    let currentResponse = response()
    const service = createPersonalIconSourceService({ fetch: async () => currentResponse })
    const identity = { displayIconId: DISPLAY_ICON_ID, mediaId: MEDIA_ID }
    const cases: Array<{ value: ReturnType<typeof response>, code: string }> = [
      { value: response(png(), { status: 302 }), code: 'unsupported' },
      { value: response(png(), { redirected: true }), code: 'unsupported' },
      { value: response(png(), { url: `${SOURCE_URL}?redirected=1` }), code: 'unsupported' },
      { value: response(png(), { status: 503 }), code: 'temporary' },
      { value: response(png(), { type: 'image/jpeg; charset=binary' }), code: 'unsupported' },
      { value: response(png(), { length: String(STATIC_ICON_MAX_BYTES + 1) }), code: 'unsupported' },
      { value: response(new Uint8Array(STATIC_ICON_MAX_BYTES + 1), { length: null }), code: 'unsupported' },
      { value: response(Uint8Array.of(1, 2, 3)), code: 'unsupported' },
    ]

    for (const testCase of cases) {
      currentResponse = testCase.value
      await assert.rejects(
        () => service.load(identity, library()),
        (error: unknown) => error instanceof PersonalIconSourceError && error.code === testCase.code,
      )
    }

    currentResponse = response(png(), { url: SOURCE_URL })
    await assert.rejects(
      () => service.load(identity, library(SOURCE_URL.replace('.com/', '.com:443/'))),
      (error: unknown) => error instanceof PersonalIconSourceError && error.code === 'unsupported',
    )
  })

  it('times out the plain unauthenticated asset request', async () => {
    const service = createPersonalIconSourceService({
      timeoutMs: 1,
      fetch: async (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      }),
    })

    await assert.rejects(
      () => Promise.race([
        service.load({ displayIconId: DISPLAY_ICON_ID, mediaId: MEDIA_ID }, library()),
        new Promise((_, reject) => setTimeout(() => reject(new Error('deadline was not active')), 50)),
      ]),
      (error: unknown) => error instanceof PersonalIconSourceError && error.code === 'temporary',
    )
  })

  it('keeps the deadline active while streaming the response body', async () => {
    const service = createPersonalIconSourceService({
      timeoutMs: 1,
      fetch: async (_url, { signal }) => ({
        ...response(),
        headers: { get: name => name.toLowerCase() === 'content-type' ? 'image/png' : null },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            signal.addEventListener('abort', () => {
              controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }))
            })
          },
        }),
      }),
    })

    await assert.rejects(
      () => Promise.race([
        service.load({ displayIconId: DISPLAY_ICON_ID, mediaId: MEDIA_ID }, library()),
        new Promise((_, reject) => setTimeout(() => reject(new Error('deadline was not active')), 50)),
      ]),
      (error: unknown) => error instanceof PersonalIconSourceError
        && error.code === 'temporary'
        && error.statusCode === 504,
    )
  })

  it('combines caller cancellation with the source deadline', async () => {
    const request = new AbortController()
    let outboundSignal: AbortSignal | undefined
    const service = createPersonalIconSourceService({
      timeoutMs: 50,
      fetch: async (_url, { signal }) => {
        outboundSignal = signal
        return await new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          }, { once: true })
        })
      },
    })

    const loading = service.load(
      { displayIconId: DISPLAY_ICON_ID, mediaId: MEDIA_ID },
      library(),
      request.signal,
    )
    await Promise.resolve()
    request.abort()

    await assert.rejects(
      () => loading,
      (error: unknown) => error instanceof PersonalIconSourceError
        && error.code === 'temporary'
        && error.statusCode === 502,
    )
    assert.equal(outboundSignal?.aborted, true)
  })

  it('cancels the response stream immediately when a chunk crosses 64 KiB', async () => {
    let cancelled = false
    const service = createPersonalIconSourceService({
      fetch: async () => ({
        ...response(),
        headers: { get: name => name.toLowerCase() === 'content-type' ? 'image/png' : null },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(STATIC_ICON_MAX_BYTES + 1))
          },
          cancel() {
            cancelled = true
          },
        }),
      }),
    })

    await assert.rejects(
      () => service.load({ displayIconId: DISPLAY_ICON_ID, mediaId: MEDIA_ID }, library()),
      (error: unknown) => error instanceof PersonalIconSourceError && error.code === 'unsupported',
    )
    assert.equal(cancelled, true)
  })
})
