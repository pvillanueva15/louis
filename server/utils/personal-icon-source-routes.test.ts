import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { afterEach, describe, it } from 'node:test'
import {
  personalIconSourceService,
  PersonalIconSourceError,
} from './personal-icon-source.ts'
import { YOTO_ACCESS_TOKEN_COOKIE } from './yoto-auth.ts'

interface HttpError extends Error {
  statusCode?: number
  statusMessage?: string
}

const DISPLAY_ICON_ID = 'display-icon'
const MEDIA_ID = 'A'.repeat(43)
const PNG = Uint8Array.of(137, 80, 78, 71)
const globalNames = [
  '$fetch',
  'createError',
  'defineEventHandler',
  'getCookie',
  'getQuery',
  'getRequestURL',
  'setCookie',
  'setHeader',
  'useRuntimeConfig',
] as const
const originalGlobals = new Map(globalNames.map(name => [
  name,
  Object.getOwnPropertyDescriptor(globalThis, name),
]))

function installRouteGlobals(
  cookies: Record<string, string> = {},
  query: Record<string, unknown> = { displayIconId: DISPLAY_ICON_ID, mediaId: MEDIA_ID },
) {
  const headers = new Map<string, string | number>()
  const yotoCalls: Array<{ url: string, options: unknown }> = []
  const globals = globalThis as Record<string, unknown>
  globals.$fetch = async (url: string, options: unknown) => {
    yotoCalls.push({ url, options })
    return { displayIcons: [{ displayIconId: DISPLAY_ICON_ID, mediaId: MEDIA_ID }] }
  }
  globals.defineEventHandler = (handler: unknown) => handler
  globals.createError = (options: { statusCode?: number, statusMessage?: string, message?: string }) => (
    Object.assign(new Error(options.statusMessage ?? options.message ?? 'HTTP error'), options)
  )
  globals.getCookie = (_event: unknown, name: string) => cookies[name]
  globals.getQuery = () => query
  globals.getRequestURL = () => new URL('http://localhost/api/yoto/icons/source')
  globals.setCookie = () => undefined
  globals.setHeader = (_event: unknown, name: string, value: string | number) => headers.set(name, value)
  globals.useRuntimeConfig = () => ({ yotoClientId: 'client', yotoClientSecret: '' })
  return { headers, yotoCalls }
}

afterEach(() => {
  for (const name of globalNames) {
    const descriptor = originalGlobals.get(name)
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete (globalThis as Record<string, unknown>)[name]
  }
})

describe('Personal Icon Source HTTP route', () => {
  it('authenticates, forwards only identity controls, and returns safe exact PNG headers', async () => {
    const { headers, yotoCalls } = installRouteGlobals({ [YOTO_ACCESS_TOKEN_COOKIE]: 'access-token' })
    const route = (await import('../api/yoto/icons/source.get.ts')).default
    const originalLoad = personalIconSourceService.load
    let loadCalls = 0
    personalIconSourceService.load = async (identity, listIcons) => {
      loadCalls += 1
      assert.deepEqual(identity, { displayIconId: DISPLAY_ICON_ID, mediaId: MEDIA_ID })
      assert.equal((await listIcons()).icons[0]!.displayIconId, DISPLAY_ICON_ID)
      return { bytes: PNG, filename: `personal-icon-${MEDIA_ID.slice(0, 12)}.png` }
    }
    try {
      assert.deepEqual(await route({}), Buffer.from(PNG))
      assert.equal(loadCalls, 1)
      assert.equal(yotoCalls.length, 1)
      assert.match(yotoCalls[0]!.url, /\/media\/displayIcons\/user\/me$/)
      assert.deepEqual((yotoCalls[0]!.options as { headers: unknown }).headers, {
        Authorization: 'Bearer access-token',
      })
      assert.equal(headers.get('Content-Type'), 'image/png')
      assert.equal(headers.get('Content-Length'), PNG.byteLength)
      assert.equal(headers.get('Cache-Control'), 'private, no-store')
      assert.equal(headers.get('X-Content-Type-Options'), 'nosniff')
      assert.equal(headers.get('Content-Disposition'), `inline; filename="personal-icon-${MEDIA_ID.slice(0, 12)}.png"`)
    }
    finally {
      personalIconSourceService.load = originalLoad
    }
  })

  it('preserves established authentication recovery and does not reach the service', async () => {
    installRouteGlobals()
    const route = (await import('../api/yoto/icons/source.get.ts')).default
    const originalLoad = personalIconSourceService.load
    let loadCalls = 0
    personalIconSourceService.load = async () => {
      loadCalls += 1
      throw new Error('unexpected source load')
    }
    try {
      await assert.rejects(() => route({}), (error: unknown) => {
        const httpError = error as HttpError
        return httpError.statusCode === 401 && /Connect to sign in/.test(httpError.statusMessage ?? '')
      })
      assert.equal(loadCalls, 0)
    }
    finally {
      personalIconSourceService.load = originalLoad
    }
  })

  it('preserves established Yoto authentication and permission recovery from the authoritative list request', async () => {
    const { yotoCalls } = installRouteGlobals({ [YOTO_ACCESS_TOKEN_COOKIE]: 'access-token' })
    const route = (await import('../api/yoto/icons/source.get.ts')).default
    const originalLoad = personalIconSourceService.load
    personalIconSourceService.load = async (_identity, listIcons) => {
      await listIcons()
      throw new Error('unexpected source continuation')
    }
    try {
      for (const expected of [
        { statusCode: 401, statusMessage: 'Yoto session expired. Please reconnect.' },
        { statusCode: 403, statusMessage: 'Yoto API access denied. Check your app scopes.' },
      ]) {
        ;(globalThis as Record<string, unknown>).$fetch = async (url: string) => {
          yotoCalls.push({ url, options: undefined })
          throw Object.assign(new Error('secret upstream authorization detail'), {
            statusCode: expected.statusCode,
            statusMessage: 'secret upstream authorization detail',
          })
        }
        await assert.rejects(() => route({}), (error: unknown) => {
          const httpError = error as HttpError
          return httpError.statusCode === expected.statusCode
            && httpError.statusMessage === expected.statusMessage
            && !httpError.message.includes('secret')
        })
      }
      assert.equal(yotoCalls.length, 2)
    }
    finally {
      personalIconSourceService.load = originalLoad
    }
  })

  it('normalizes malformed and failed authoritative lists without exposing upstream details', async () => {
    const { yotoCalls } = installRouteGlobals({ [YOTO_ACCESS_TOKEN_COOKIE]: 'access-token' })
    const route = (await import('../api/yoto/icons/source.get.ts')).default
    const originalLoad = personalIconSourceService.load
    const failures = [
      async () => ({ secret: 'malformed library detail' }),
      async () => {
        throw Object.assign(new Error('secret list transport detail'), {
          statusCode: 503,
          statusMessage: 'secret list transport detail',
        })
      },
    ]
    try {
      for (const fetcher of failures) {
        ;(globalThis as Record<string, unknown>).$fetch = async (url: string) => {
          yotoCalls.push({ url, options: undefined })
          return await fetcher()
        }
        personalIconSourceService.load = originalLoad
        await assert.rejects(() => route({}), (error: unknown) => {
          const httpError = error as HttpError
          return httpError.statusCode === 502
            && httpError.statusMessage === 'Louis couldn’t load this icon. Try again.'
            && !httpError.message.includes('secret')
            && !httpError.message.includes('malformed')
        })
      }
      assert.equal(yotoCalls.length, 2)
    }
    finally {
      personalIconSourceService.load = originalLoad
    }
  })

  it('preserves duplicate upstream pair multiplicity and rejects it before asset fetch', async () => {
    const { yotoCalls } = installRouteGlobals({ [YOTO_ACCESS_TOKEN_COOKIE]: 'access-token' })
    ;(globalThis as Record<string, unknown>).$fetch = async (url: string, options: unknown) => {
      yotoCalls.push({ url, options })
      const icon = {
        displayIconId: DISPLAY_ICON_ID,
        mediaId: MEDIA_ID,
        url: `https://media-secure-v2.api.yotoplay.com/${MEDIA_ID}.png`,
      }
      return { displayIcons: [icon, { ...icon }] }
    }
    const route = (await import('../api/yoto/icons/source.get.ts')).default
    const originalLoad = personalIconSourceService.load
    let visibleCandidates = 0
    personalIconSourceService.load = async (identity, listIcons) => originalLoad.call(
      personalIconSourceService,
      identity,
      async () => {
        const candidates = await listIcons()
        visibleCandidates = candidates.icons.length
        assert.equal(visibleCandidates, 2, 'source resolution must see raw validated multiplicity')
        return candidates
      },
    )
    try {
      await assert.rejects(() => route({}), (error: unknown) => {
        const httpError = error as HttpError
        return httpError.statusCode === 404
          && httpError.statusMessage === 'This personal icon is no longer available. Refresh My Icons and try again.'
      })
      assert.equal(visibleCandidates, 2)
      assert.equal(yotoCalls.length, 1)
    }
    finally {
      personalIconSourceService.load = originalLoad
    }
  })

  it('maps source failures to stable recovery messages without leaking details', async () => {
    installRouteGlobals({ [YOTO_ACCESS_TOKEN_COOKIE]: 'access-token' })
    const route = (await import('../api/yoto/icons/source.get.ts')).default
    const originalLoad = personalIconSourceService.load
    const cases = [
      {
        error: new PersonalIconSourceError('unavailable', 404, 'secret stale URL'),
        status: 404,
        message: 'This personal icon is no longer available. Refresh My Icons and try again.',
      },
      {
        error: new PersonalIconSourceError('unsupported', 415, 'secret validation detail'),
        status: 415,
        message: 'This personal icon can’t be edited in Icon Studio.',
      },
      {
        error: new PersonalIconSourceError('temporary', 502, 'secret upstream detail'),
        status: 502,
        message: 'Louis couldn’t load this icon. Try again.',
      },
    ]
    try {
      for (const testCase of cases) {
        personalIconSourceService.load = async () => { throw testCase.error }
        await assert.rejects(() => route({}), (error: unknown) => {
          const httpError = error as HttpError
          return httpError.statusCode === testCase.status
            && httpError.statusMessage === testCase.message
            && !httpError.message.includes('secret')
        })
      }
    }
    finally {
      personalIconSourceService.load = originalLoad
    }
  })

  it('aborts the outbound source work when the requesting client disconnects', async () => {
    installRouteGlobals({ [YOTO_ACCESS_TOKEN_COOKIE]: 'access-token' })
    const route = (await import('../api/yoto/icons/source.get.ts')).default
    const originalLoad = personalIconSourceService.load
    const req = new EventEmitter()
    const res = new EventEmitter()
    let outboundSignal: AbortSignal | undefined
    personalIconSourceService.load = async (_identity, _listIcons, signal) => {
      outboundSignal = signal
      return await new Promise((_resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error('request signal was not provided')), 50)
        signal?.addEventListener('abort', () => {
          clearTimeout(deadline)
          reject(new PersonalIconSourceError('temporary', 502, 'request cancelled'))
        }, { once: true })
      })
    }
    try {
      const response = route({ node: { req, res } })
      await Promise.resolve()
      res.emit('close')
      await assert.rejects(() => response, (error: unknown) => {
        const httpError = error as HttpError
        return httpError.statusCode === 502
          && httpError.statusMessage === 'Louis couldn’t load this icon. Try again.'
      })
      assert.equal(outboundSignal?.aborted, true)
    }
    finally {
      personalIconSourceService.load = originalLoad
    }
  })
})
