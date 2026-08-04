import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { deflateSync } from 'node:zlib'
import { STATIC_ICON_MAX_BYTES } from '../../shared/yoto/staticIcon.ts'
import {
  COMMUNITY_ICON_HTML_MAX_BYTES,
  CommunityIconError,
  CommunityIconService,
  CommunityIconUploadOutcomeUncertainError,
  parseCommunityIconSearchHtml,
} from './community-icons.ts'

const MEDIA_ID = 'M'.repeat(43)

function checksum(bytes: Uint8Array): number {
  let value = 0xffffffff
  for (const byte of bytes) {
    value ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
    }
  }
  return (value ^ 0xffffffff) >>> 0
}

function join(...parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.byteLength
  }
  return bytes
}

function chunk(type: string, data = new Uint8Array()): Uint8Array {
  const bytes = new Uint8Array(12 + data.byteLength)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, data.byteLength)
  bytes.set(new TextEncoder().encode(type), 4)
  bytes.set(data, 8)
  view.setUint32(8 + data.byteLength, checksum(bytes.slice(4, 8 + data.byteLength)))
  return bytes
}

function png(width = 16, height = 16): Uint8Array {
  const ihdr = new Uint8Array(13)
  const view = new DataView(ihdr.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  ihdr.set([8, 6, 0, 0, 0], 8)
  const scanlines = new Uint8Array(height * (1 + width * 4))
  return join(
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(scanlines)),
    chunk('IEND'),
  )
}

function indexedPng(width = 16, height = 16): Uint8Array {
  const ihdr = new Uint8Array(13)
  const view = new DataView(ihdr.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  ihdr.set([8, 3, 0, 0, 0], 8)
  const scanlines = new Uint8Array(height * (1 + width))
  return join(
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('sRGB', Uint8Array.of(0)),
    chunk('pHYs', new Uint8Array(9)),
    chunk('PLTE', Uint8Array.of(0, 0, 0, 255, 255, 255)),
    chunk('tRNS', Uint8Array.of(255, 128)),
    chunk('IDAT', deflateSync(scanlines)),
    chunk('IEND'),
  )
}

function liveRgba128Png(): Uint8Array {
  const width = 128
  const height = 128
  const ihdr = new Uint8Array(13)
  const view = new DataView(ihdr.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  ihdr.set([8, 6, 0, 0, 0], 8)
  const compressed = deflateSync(new Uint8Array(height * (1 + width * 4)))
  const split = Math.max(1, Math.floor(compressed.byteLength / 2))
  return join(
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('sRGB', Uint8Array.of(0)),
    chunk('eXIf', new Uint8Array()),
    chunk('iDOT', new Uint8Array(28)),
    chunk('IDAT', compressed.slice(0, split)),
    chunk('IDAT', compressed.slice(split)),
    chunk('IEND'),
  )
}

function card(
  id: string,
  overrides: Partial<{
    assetId: string
    category: string
    title: string
    tag: string
    creator: string
    artist: string
    downloads: string
  }> = {},
): string {
  const values = {
    assetId: id,
    category: 'animals',
    title: 'Pete&#39;s Cat',
    tag: 'bedtime stories',
    creator: 'curiouscat',
    artist: 'curiouscat',
    downloads: '42',
    ...overrides,
  }
  return `
    <div class="icon" onclick="populate_icon_modal('${id}', '${values.category}', '${values.title}', '${values.tag}', '${values.creator}', '${values.downloads}');">
      <div class="icon_background"><img src="/static/uploads/${values.assetId}.png"></div>
      <div class="artist">@${values.artist}</div>
    </div>`
}

function htmlWithTotal(total: number, ...cards: string[]): string {
  return `<html><section id="search_info"><p>We&#39;ve got ${total} icons with that tag:</p></section><section id="search_results">${cards.join('')}<div class="icon ko-fi">support</div></section></html>`
}

function html(...cards: string[]): string {
  return htmlWithTotal(cards.length, ...cards)
}

function emptyHtml(): string {
  return htmlWithTotal(0)
}

function response(
  url: string,
  body: BodyInit | null,
  options: { status?: number, type?: string, length?: number, redirected?: boolean, responseUrl?: string } = {},
) {
  const native = new Response(body, {
    status: options.status ?? 200,
    headers: {
      'content-type': options.type ?? 'text/html',
      ...(options.length === undefined ? {} : { 'content-length': String(options.length) }),
    },
  })
  return {
    status: native.status,
    headers: native.headers,
    body: native.body,
    redirected: options.redirected ?? false,
    url: options.responseUrl ?? url,
  }
}

describe('Yotoicons server boundary', () => {
  it('parses required metadata, internal preview, source link, and optional downloads', () => {
    const result = parseCommunityIconSearchHtml(html(
      card('12583'),
      card('8703', { title: 'Gruffalo', tag: '', downloads: '' }),
    ), 'blue cat')

    assert.deepEqual(result, {
      query: 'blue cat',
      page: 1,
      nextPage: null,
      icons: [{
        id: '12583',
        page: 1,
        title: "Pete's Cat",
        tags: ['animals', 'bedtime stories'],
        creator: 'curiouscat',
        downloads: 42,
        previewUrl: '/api/yoto/icons/community/12583/preview',
        sourceUrl: 'https://www.yotoicons.com/icons?tag=blue+cat&sort=popular&type=singles&page=1',
      }, {
        id: '8703',
        page: 1,
        title: 'Gruffalo',
        tags: ['animals'],
        creator: 'curiouscat',
        downloads: null,
        previewUrl: '/api/yoto/icons/community/8703/preview',
        sourceUrl: 'https://www.yotoicons.com/icons?tag=blue+cat&sort=popular&type=singles&page=1',
      }],
    })
  })

  it('fails closed on markup drift, duplicate IDs, mismatches, and missing fields', () => {
    assert.throws(() => parseCommunityIconSearchHtml('<html></html>', 'cat'), /markup changed/)
    assert.throws(() => parseCommunityIconSearchHtml(html(card('1'), card('1')), 'cat'), /duplicate/)
    assert.throws(() => parseCommunityIconSearchHtml(html(card('1', { assetId: '2' })), 'cat'), /mismatched icon asset/)
    assert.throws(() => parseCommunityIconSearchHtml(html(card('1', { artist: 'someone-else' })), 'cat'), /creator metadata/)
    assert.throws(() => parseCommunityIconSearchHtml(html(card('1', { title: '' })), 'cat'), /invalid title/)
    assert.throws(() => parseCommunityIconSearchHtml(htmlWithTotal(1), 'cat'), /markup changed/)
    assert.throws(
      () => parseCommunityIconSearchHtml(html(card('1').replace('class="icon"', 'class="icon featured"')), 'cat'),
      /markup changed/,
    )
    assert.throws(
      () => parseCommunityIconSearchHtml(html(...Array.from({ length: 26 }, (_, index) => card(String(index + 1)))), 'cat'),
      /exceeded 25/,
    )
    assert.deepEqual(parseCommunityIconSearchHtml(emptyHtml(), 'missing'), {
      query: 'missing',
      page: 1,
      nextPage: null,
      icons: [],
    })
  })

  it('parses bounded later pages and exposes the next page from the upstream total', () => {
    const pageTwo = parseCommunityIconSearchHtml(
      htmlWithTotal(51, ...Array.from({ length: 25 }, (_, index) => card(String(index + 26)))),
      'cat',
      2,
    )
    assert.equal(pageTwo.page, 2)
    assert.equal(pageTwo.nextPage, 3)
    assert.equal(pageTwo.icons.length, 25)
    assert.equal(pageTwo.icons[0]?.page, 2)
    assert.match(pageTwo.icons[0]?.sourceUrl ?? '', /page=2$/)

    const finalPage = parseCommunityIconSearchHtml(htmlWithTotal(51, card('51')), 'cat', 3)
    assert.equal(finalPage.nextPage, null)
    assert.deepEqual(finalPage.icons.map(icon => icon.id), ['51'])

    const boundedPage = parseCommunityIconSearchHtml(
      htmlWithTotal(25_001, ...Array.from({ length: 25 }, (_, index) => card(String(index + 1)))),
      'cat',
      1_000,
    )
    assert.equal(boundedPage.nextPage, null)
  })

  it('uses the exact bounded search URL and rejects upstream 403/429', async () => {
    for (const status of [403, 429]) {
      const calls: string[] = []
      const service = new CommunityIconService({
        fetch: async (url) => {
          calls.push(url)
          return response(url, 'denied', { status })
        },
      })
      await assert.rejects(() => service.search(' blue cat '), /rejected the request/)
      assert.deepEqual(calls, [
        'https://www.yotoicons.com/icons?tag=blue+cat&sort=popular&type=singles&page=1',
      ])
    }
  })

  it('owns shared query and page validation as a 400 without fetching upstream', async () => {
    let fetched = false
    const service = new CommunityIconService({
      fetch: async (url) => {
        fetched = true
        return response(url, html(card('1')))
      },
    })
    await assert.rejects(
      () => service.search(undefined),
      (error: unknown) => error instanceof CommunityIconError && error.statusCode === 400,
    )
    await assert.rejects(
      () => service.search('cat', { page: 'next' }),
      (error: unknown) => error instanceof CommunityIconError && error.statusCode === 400,
    )
    await assert.rejects(
      () => service.importIcon(' ', '1', 1, 'token', async () => ({})),
      (error: unknown) => error instanceof CommunityIconError && error.statusCode === 400,
    )
    await assert.rejects(
      () => service.importIcon('cat', '1', 0, 'token', async () => ({})),
      (error: unknown) => error instanceof CommunityIconError && error.statusCode === 400,
    )
    assert.equal(fetched, false)
  })

  it('rejects redirects, unexpected targets, oversized HTML, and malformed content types', async () => {
    const cases = [
      { options: { status: 302 }, message: /redirects are not allowed/ },
      { options: { responseUrl: 'https://example.com/icons' }, message: /unexpected response URL/ },
      { options: { length: COMMUNITY_ICON_HTML_MAX_BYTES + 1 }, message: /exceeded the allowed size/ },
      { options: { type: 'application/json' }, message: /unsupported text\/html/ },
    ]
    for (const testCase of cases) {
      const service = new CommunityIconService({
        fetch: async url => response(url, html(card('1')), testCase.options),
      })
      await assert.rejects(() => service.search('cat'), testCase.message)
    }

    const chunkedOversized = new CommunityIconService({
      fetch: async url => response(url, new Uint8Array(COMMUNITY_ICON_HTML_MAX_BYTES + 1)),
    })
    await assert.rejects(() => chunkedOversized.search('cat'), /exceeded the allowed size/)
  })

  it('enforces a deterministic total timeout before fetching', async () => {
    const times = [0, 6_000]
    let fetched = false
    const service = new CommunityIconService({
      now: () => times.shift() ?? 6_000,
      fetch: async (url) => {
        fetched = true
        return response(url, html(card('1')))
      },
    })
    await assert.rejects(() => service.search('cat'), (error: unknown) =>
      error instanceof CommunityIconError && error.statusCode === 504,
    )
    assert.equal(fetched, false)
  })

  it('uses short cache, request coalescing, and deterministic per-process throttling', async () => {
    let now = 0
    let fetches = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const service = new CommunityIconService({
      now: () => now,
      cacheTtlMs: 10,
      publicThrottleLimit: 2,
      throttleWindowMs: 100,
      fetch: async (url) => {
        fetches += 1
        if (fetches === 1) await gate
        return response(url, html(card(String(fetches))))
      },
    })

    const first = service.search('cat')
    const joined = service.search('cat')
    release()
    assert.equal(await first, await joined)
    assert.equal(fetches, 1)
    await service.search('cat')
    assert.equal(fetches, 1)

    now = 11
    await service.search('cat')
    assert.equal(fetches, 2)
    await assert.rejects(() => service.search('dog'), (error: unknown) =>
      error instanceof CommunityIconError && error.statusCode === 429,
    )
  })

  it('allows two fully previewed result pages within the default public throttle', async () => {
    const service = new CommunityIconService({
      fetch: async url => {
        if (!url.includes('/icons?')) return response(url, png(), { type: 'image/png' })
        const page = url.endsWith('page=2') ? 2 : 1
        const firstId = page === 1 ? 1 : 26
        return response(url, htmlWithTotal(
          50,
          ...Array.from({ length: 25 }, (_, index) => card(String(firstId + index))),
        ))
      },
    })

    for (const page of [1, 2]) {
      const results = await service.search('cat', { page })
      for (const icon of results.icons) await service.preview(icon.id)
    }
  })

  it('keeps public read traffic from consuming authenticated import capacity', async () => {
    const service = new CommunityIconService({
      publicThrottleLimit: 2,
      importThrottleLimit: 2,
      fetch: async url => url.includes('/icons?')
        ? response(url, html(card('1')))
        : response(url, png(), { type: 'image/png' }),
    })

    await service.search('cat')
    await service.preview('1')
    await assert.rejects(
      () => service.search('dog'),
      (error: unknown) => error instanceof CommunityIconError && error.statusCode === 429,
    )

    const imported = await service.importIcon('cat', '1', 1, 'token', async () => ({
      displayIcon: {
        mediaId: MEDIA_ID,
        displayIconId: 'isolated-import',
        new: true,
      },
    }))
    assert.equal(imported.icon.displayIconId, 'isolated-import')
  })

  it('fetches only the fixed numeric PNG path and validates the bounded community PNG contract', async () => {
    const calls: string[] = []
    const valid = new CommunityIconService({
      fetch: async (url) => {
        calls.push(url)
        return response(url, png(), { type: 'image/png' })
      },
    })
    assert.deepEqual(await valid.preview('12583'), png())
    assert.deepEqual(calls, ['https://www.yotoicons.com/static/uploads/12583.png'])

    const oversized = new CommunityIconService({
      fetch: async url => response(url, png(), { type: 'image/png', length: STATIC_ICON_MAX_BYTES + 1 }),
    })
    await assert.rejects(() => oversized.preview('1'), /exceeded the allowed size/)

    const chunkedOversized = new CommunityIconService({
      fetch: async url => response(url, new Uint8Array(STATIC_ICON_MAX_BYTES + 1), { type: 'image/png' }),
    })
    await assert.rejects(() => chunkedOversized.preview('1'), /exceeded the allowed size/)

    const wrongDimensions = new CommunityIconService({
      fetch: async url => response(url, png(257, 1), { type: 'image/png' }),
    })
    await assert.rejects(() => wrongDimensions.preview('1'), /between 1×1 and 256×256/)
    await assert.rejects(() => wrongDimensions.preview('../1'), /canonical numeric ID/)
  })

  it('returns and imports original live-shape indexed and 128px RGBA community PNGs', async () => {
    for (const [id, bytes] of [
      ['6164', indexedPng()],
      ['4023', liveRgba128Png()],
    ] as const) {
      const yotoCalls: Array<{ path: string, body: unknown }> = []
      const service = new CommunityIconService({
        fetch: async url => url.includes('/icons?')
          ? response(url, html(card(id)))
          : response(url, bytes, { type: 'image/png' }),
      })

      assert.deepEqual(await service.preview(id), bytes)
      const result = await service.importIcon('cat', id, 1, 'token', async (path, _token, options) => {
        yotoCalls.push({ path, body: options?.body })
        return {
          displayIcon: {
            mediaId: MEDIA_ID,
            displayIconId: `personal-${id}`,
            new: true,
          },
        }
      })
      assert.equal(result.icon.displayIconId, `personal-${id}`)
      assert.deepEqual(yotoCalls, [{
        path: `/media/displayIcons/user/me/upload?autoConvert=true&filename=yotoicons-${id}`,
        body: bytes,
      }])
    }
  })

  it('re-fetches metadata and bytes, then uses only the existing Yoto upload/reuse seam', async () => {
    const upstreamCalls: string[] = []
    const yotoCalls: string[] = []
    const bytes = png()
    const service = new CommunityIconService({
      fetch: async (url) => {
        upstreamCalls.push(url)
        return url.includes('/icons?')
          ? response(url, html(card('12583')))
          : response(url, bytes, { type: 'image/png' })
      },
    })

    const result = await service.importIcon('cat', '12583', 1, 'token', async (path, token, options) => {
      yotoCalls.push(path)
      assert.equal(token, 'token')
      assert.equal(options?.method, 'POST')
      assert.deepEqual(options?.body, bytes)
      assert.ok(options?.signal)
      return {
        displayIcon: {
          mediaId: MEDIA_ID,
          displayIconId: 'personal-1',
          url: 'https://cdn.example/icon.png',
          new: true,
        },
      }
    })

    assert.deepEqual(upstreamCalls, [
      'https://www.yotoicons.com/icons?tag=cat&sort=popular&type=singles&page=1',
      'https://www.yotoicons.com/static/uploads/12583.png',
    ])
    assert.deepEqual(yotoCalls, [
      '/media/displayIcons/user/me/upload?autoConvert=true&filename=yotoicons-12583',
    ])
    assert.equal(result.icon.mediaId, MEDIA_ID)
    assert.equal(upstreamCalls.some(url => /save-jobs|youtube|audio|content/.test(url)), false)
    assert.equal(yotoCalls.some(url => /save-jobs|youtube|audio|content/.test(url)), false)
  })

  it('revalidates an imported later-page icon against that exact page', async () => {
    const upstreamCalls: string[] = []
    const service = new CommunityIconService({
      fetch: async (url) => {
        upstreamCalls.push(url)
        return url.includes('/icons?')
          ? response(url, htmlWithTotal(26, card('26')))
          : response(url, png(), { type: 'image/png' })
      },
    })

    await service.importIcon('cat', '26', 2, 'token', async () => ({
      displayIcon: {
        mediaId: MEDIA_ID,
        displayIconId: 'personal-26',
        new: true,
      },
    }))
    assert.deepEqual(upstreamCalls, [
      'https://www.yotoicons.com/icons?tag=cat&sort=popular&type=singles&page=2',
      'https://www.yotoicons.com/static/uploads/26.png',
    ])
  })

  it('keeps a fresh import metadata request separate from an ordinary in-flight search', async () => {
    let searchCalls = 0
    let releaseOrdinary!: () => void
    const ordinaryGate = new Promise<void>((resolve) => { releaseOrdinary = resolve })
    const service = new CommunityIconService({
      fetch: async (url) => {
        if (!url.includes('/icons?')) return response(url, png(), { type: 'image/png' })
        searchCalls += 1
        if (searchCalls === 1) {
          await ordinaryGate
          return response(url, html(card('1')))
        }
        return response(url, html(card('2')))
      },
    })

    const ordinary = service.search('cat')
    const imported = service.importIcon('cat', '2', 1, 'token', async () => ({
      displayIcon: {
        mediaId: MEDIA_ID,
        displayIconId: 'personal-2',
        new: true,
      },
    }))
    assert.equal((await imported).icon.displayIconId, 'personal-2')
    assert.equal(searchCalls, 2)
    releaseOrdinary()
    await ordinary
  })

  it('never coalesces concurrent fresh searches with different cancellation signals', async () => {
    const pending: Array<{
      resolve: (value: ReturnType<typeof response>) => void
      signal: AbortSignal
    }> = []
    const service = new CommunityIconService({
      fetch: async (url, options) => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
        pending.push({ resolve: value => resolve(value), signal: options.signal })
      }),
    })
    const firstController = new AbortController()
    const secondController = new AbortController()
    const deadline = Date.now() + 5_000
    const first = service.search('cat', { fresh: true, deadline, signal: firstController.signal })
    const second = service.search('cat', { fresh: true, deadline, signal: secondController.signal })
    assert.equal(pending.length, 2)
    assert.notEqual(pending[0]!.signal, pending[1]!.signal)

    firstController.abort()
    pending[1]!.resolve(response(
      'https://www.yotoicons.com/icons?tag=cat&sort=popular&type=singles&page=1',
      html(card('2')),
    ))
    await assert.rejects(
      () => first,
      (error: unknown) => error instanceof CommunityIconError && error.statusCode === 504,
    )
    assert.equal((await second).icons[0]?.id, '2')
  })

  it('marks a stalled aborted Yoto upload as outcome-uncertain', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] })
    let uploadStarted!: () => void
    const started = new Promise<void>((resolve) => { uploadStarted = resolve })
    let uploadSignal: AbortSignal | undefined
    const service = new CommunityIconService({
      fetch: async url => url.includes('/icons?')
        ? response(url, html(card('1')))
        : response(url, png(), { type: 'image/png' }),
    })

    const imported = service.importIcon('cat', '1', 1, 'token', async (_path, _token, options) => {
      uploadSignal = options?.signal
      uploadStarted()
      return new Promise((_, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
      })
    })
    await started
    assert.equal(uploadSignal?.aborted, false)
    context.mock.timers.tick(5_000)
    await assert.rejects(
      () => imported,
      (error: unknown) => (
        error instanceof CommunityIconUploadOutcomeUncertainError
        && error.statusCode === 502
        && /Do not retry blindly/.test(error.message)
      ),
    )
    assert.equal(uploadSignal?.aborted, true)
  })

  it('preserves definite Yoto upload rejections without marking the outcome uncertain', async () => {
    for (const statusCode of [400, 401, 403, 404, 409, 422]) {
      const rejection = Object.assign(new Error(`Yoto rejected ${statusCode}`), { statusCode })
      const service = new CommunityIconService({
        fetch: async url => url.includes('/icons?')
          ? response(url, html(card('1')))
          : response(url, png(), { type: 'image/png' }),
      })
      await assert.rejects(
        () => service.importIcon('cat', '1', 1, 'token', async () => Promise.reject(rejection)),
        error => error === rejection,
      )
    }
  })

  it('marks transport, ambiguous HTTP, and malformed successful uploads as outcome-uncertain', async () => {
    const failures: Array<() => Promise<unknown>> = [
      () => Promise.reject(new TypeError('fetch failed')),
      () => Promise.reject(Object.assign(new Error('timeout'), { statusCode: 408 })),
      () => Promise.reject(Object.assign(new Error('rate limited'), { statusCode: 429 })),
      () => Promise.reject(Object.assign(new Error('gateway failed'), { statusCode: 502 })),
      async () => ({ ok: true }),
    ]
    for (const upload of failures) {
      const service = new CommunityIconService({
        fetch: async url => url.includes('/icons?')
          ? response(url, html(card('1')))
          : response(url, png(), { type: 'image/png' }),
      })
      await assert.rejects(
        () => service.importIcon('cat', '1', 1, 'token', upload),
        CommunityIconUploadOutcomeUncertainError,
      )
    }
  })

  it('keeps a pre-upload metadata timeout as an ordinary 504', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] })
    let yotoCalls = 0
    const service = new CommunityIconService({
      fetch: async (_url, options) => new Promise((_, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
      }),
    })
    const imported = service.importIcon('cat', '1', 1, 'token', async () => {
      yotoCalls += 1
      return {}
    })
    context.mock.timers.tick(5_000)
    await assert.rejects(
      () => imported,
      (error: unknown) => error instanceof CommunityIconError && error.statusCode === 504,
    )
    assert.equal(yotoCalls, 0)
  })

  it('refuses import when freshly fetched metadata no longer contains the requested ID', async () => {
    let fetches = 0
    const service = new CommunityIconService({
      fetch: async (url) => {
        fetches += 1
        return response(url, html(card('2')))
      },
    })
    await assert.rejects(
      () => service.importIcon('cat', '1', 1, 'token', async () => ({})),
      (error: unknown) => error instanceof CommunityIconError && error.statusCode === 404,
    )
    assert.equal(fetches, 1)
  })
})
