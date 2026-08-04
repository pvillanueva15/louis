import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import {
  communityIconService,
  CommunityIconError,
  CommunityIconUploadOutcomeUncertainError,
} from './community-icons.ts'
import { COMMUNITY_ICON_UPLOAD_OUTCOME_UNCERTAIN } from '../../shared/yoto/communityIconContract.ts'
import {
  YOTO_ACCESS_TOKEN_COOKIE,
  YOTO_REFRESH_TOKEN_COOKIE,
  YOTO_SCOPE_COOKIE,
} from './yoto-auth.ts'
import {
  fetchPersonalIcons,
  RECENT_YOTO_TOKEN_VALIDATION_TTL_MS,
  resetRecentYotoTokenValidationsForTests,
  YotoIconContractError,
} from './yoto-icons.ts'
import { fetchYotoApi } from './yoto.ts'

interface HttpError extends Error {
  statusCode?: number
  statusMessage?: string
}

const globalNames = [
  '$fetch',
  'createError',
  'defineEventHandler',
  'getCookie',
  'getQuery',
  'getRequestURL',
  'getRouterParam',
  'readBody',
  'setCookie',
  'setHeader',
  'useRuntimeConfig',
] as const

const originalGlobals = new Map(globalNames.map(name => [
  name,
  Object.getOwnPropertyDescriptor(globalThis, name),
]))

function installRouteGlobals(cookies: Record<string, string> = {}): void {
  const globals = globalThis as Record<string, unknown>
  globals.$fetch = async () => ({ displayIcons: [] })
  globals.defineEventHandler = (handler: unknown) => handler
  globals.createError = (options: { statusCode?: number, statusMessage?: string, message?: string }) => {
    return Object.assign(new Error(options.statusMessage ?? options.message ?? 'HTTP error'), options)
  }
  globals.getCookie = (_event: unknown, name: string) => cookies[name]
  globals.getQuery = () => ({ q: 'cat', page: '2' })
  globals.getRouterParam = () => '1'
  globals.readBody = async () => ({ query: 'cat', page: 2 })
  globals.setCookie = () => undefined
  globals.setHeader = () => undefined
  globals.useRuntimeConfig = () => ({ yotoClientId: 'client', yotoClientSecret: '' })
  globals.getRequestURL = () => new URL('http://localhost/')
}

afterEach(() => {
  resetRecentYotoTokenValidationsForTests()
  for (const name of globalNames) {
    const descriptor = originalGlobals.get(name)
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete (globalThis as Record<string, unknown>)[name]
  }
})

describe('community icon HTTP routes', () => {
  it('keeps public search and preview independent of forgeable cookie presence', async () => {
    installRouteGlobals()
    const searchHandler = (await import('../api/yoto/icons/community/search.get.ts')).default
    const previewHandler = (await import('../api/yoto/icons/community/[id]/preview.get.ts')).default
    const originalSearch = communityIconService.search
    const originalPreview = communityIconService.preview
    let serviceCalls = 0
    communityIconService.search = async (_query, options) => {
      serviceCalls += 1
      assert.equal(options.page, '2')
      return { query: 'cat', page: 2, nextPage: null, icons: [] }
    }
    communityIconService.preview = async () => {
      serviceCalls += 1
      return new Uint8Array()
    }
    try {
      assert.deepEqual(await searchHandler({}), { query: 'cat', page: 2, nextPage: null, icons: [] })
      assert.deepEqual(await previewHandler({}), Buffer.from([]))
      assert.equal(serviceCalls, 2)
    }
    finally {
      communityIconService.search = originalSearch
      communityIconService.preview = originalPreview
    }
  })

  it('keeps community import behind the real manage-scope and token route boundary', async () => {
    installRouteGlobals()
    const importHandler = (await import('../api/yoto/icons/community/[id]/import.post.ts')).default
    const originalImport = communityIconService.importIcon
    let importCalls = 0
    communityIconService.importIcon = async () => {
      importCalls += 1
      throw new Error('unexpected import')
    }
    try {
      await assert.rejects(() => importHandler({}), (error: unknown) => {
        return (error as HttpError).statusCode === 403
      })
      assert.equal(importCalls, 0)
    }
    finally {
      communityIconService.importIcon = originalImport
    }
  })

  it('rejects an unvalidated forged token before any Yoto request, import service, or throttle', async () => {
    const cookies = {
      [YOTO_ACCESS_TOKEN_COOKIE]: 'forged-token',
      [YOTO_REFRESH_TOKEN_COOKIE]: 'forged-refresh-token',
      [YOTO_SCOPE_COOKIE]: 'user:content:manage',
    }
    installRouteGlobals(cookies)
    let yotoCalls = 0
    let bodyCalls = 0
    ;(globalThis as Record<string, unknown>).$fetch = async () => {
      yotoCalls += 1
      throw new Error('unexpected Yoto request')
    }
    ;(globalThis as Record<string, unknown>).readBody = async () => {
      bodyCalls += 1
      return { query: 'cat' }
    }
    const importHandler = (await import('../api/yoto/icons/community/[id]/import.post.ts')).default
    const originalImport = communityIconService.importIcon
    let importCalls = 0
    communityIconService.importIcon = async () => {
      importCalls += 1
      throw new Error('unexpected import')
    }
    try {
      await assert.rejects(() => importHandler({}), (error: unknown) => {
        const httpError = error as HttpError
        return httpError.statusCode === 401 && /close and reopen My Icons/i.test(httpError.message)
      })
      assert.equal(yotoCalls, 0)
      assert.equal(bodyCalls, 0)
      assert.equal(importCalls, 0)
    }
    finally {
      communityIconService.importIcon = originalImport
    }
  })

  it('uses the same recently validated stored token when no refresh cookie exists', async () => {
    const cookies = {
      [YOTO_ACCESS_TOKEN_COOKIE]: 'valid-token',
      [YOTO_SCOPE_COOKIE]: 'user:content:manage',
    }
    installRouteGlobals(cookies)
    await fetchPersonalIcons('valid-token', async () => ({ displayIcons: [] }))
    let yotoCalls = 0
    ;(globalThis as Record<string, unknown>).$fetch = async () => {
      yotoCalls += 1
      throw new Error('unexpected route-time Yoto request')
    }
    const importHandler = (await import('../api/yoto/icons/community/[id]/import.post.ts')).default
    const originalImport = communityIconService.importIcon
    let importCalls = 0
    communityIconService.importIcon = async (_query, _id, page, token) => {
      importCalls += 1
      assert.equal(page, 2)
      assert.equal(token, 'valid-token')
      return { icon: { mediaId: 'M'.repeat(43), displayIconId: 'imported', url: null, createdAt: null }, disposition: 'created' }
    }
    try {
      assert.equal((await importHandler({})).icon.displayIconId, 'imported')
      assert.equal(importCalls, 1)
      assert.equal(yotoCalls, 0)
    }
    finally {
      communityIconService.importIcon = originalImport
    }
  })

  it('allows one token refresh after the stored token has recent validation', async () => {
    const cookies = {
      [YOTO_ACCESS_TOKEN_COOKIE]: 'validated-stored-token',
      [YOTO_REFRESH_TOKEN_COOKIE]: 'refresh-token',
      [YOTO_SCOPE_COOKIE]: 'user:content:manage',
    }
    installRouteGlobals(cookies)
    await fetchPersonalIcons('validated-stored-token', async () => ({ displayIcons: [] }))
    const refreshUrls: string[] = []
    ;(globalThis as Record<string, unknown>).$fetch = async (url: string) => {
      refreshUrls.push(url)
      return {
        access_token: 'rotated-token',
        token_type: 'Bearer',
        expires_in: 3_600,
      }
    }
    const importHandler = (await import('../api/yoto/icons/community/[id]/import.post.ts')).default
    const originalImport = communityIconService.importIcon
    let importCalls = 0
    communityIconService.importIcon = async (_query, _id, page, token) => {
      importCalls += 1
      assert.equal(page, 2)
      assert.equal(token, 'rotated-token')
      return { icon: { mediaId: 'M'.repeat(43), displayIconId: 'rotated-import', url: null, createdAt: null }, disposition: 'created' }
    }
    try {
      assert.equal((await importHandler({})).icon.displayIconId, 'rotated-import')
      assert.equal(importCalls, 1)
      assert.equal(refreshUrls.length, 1)
      assert.match(refreshUrls[0]!, /\/oauth\/token$/)
    }
    finally {
      communityIconService.importIcon = originalImport
    }
  })

  it('rejects expired stored-token validation before refresh, body, service, or throttle', async () => {
    let now = 1_000
    resetRecentYotoTokenValidationsForTests(() => now)
    await fetchPersonalIcons('expired-token', async () => ({ displayIcons: [] }))
    now += RECENT_YOTO_TOKEN_VALIDATION_TTL_MS
    const cookies = {
      [YOTO_ACCESS_TOKEN_COOKIE]: 'expired-token',
      [YOTO_REFRESH_TOKEN_COOKIE]: 'refresh-token',
      [YOTO_SCOPE_COOKIE]: 'user:content:manage',
    }
    installRouteGlobals(cookies)
    let yotoCalls = 0
    let bodyCalls = 0
    ;(globalThis as Record<string, unknown>).$fetch = async () => {
      yotoCalls += 1
      throw new Error('unexpected refresh')
    }
    ;(globalThis as Record<string, unknown>).readBody = async () => {
      bodyCalls += 1
      return { query: 'cat' }
    }
    const importHandler = (await import('../api/yoto/icons/community/[id]/import.post.ts')).default
    const originalImport = communityIconService.importIcon
    let importCalls = 0
    communityIconService.importIcon = async () => {
      importCalls += 1
      throw new Error('unexpected import')
    }
    try {
      await assert.rejects(
        () => importHandler({}),
        (error: unknown) => (error as HttpError).statusCode === 401,
      )
      assert.equal(yotoCalls, 0)
      assert.equal(bodyCalls, 0)
      assert.equal(importCalls, 0)
    }
    finally {
      communityIconService.importIcon = originalImport
    }
  })

  it('maps community query errors to 400 and malformed Yoto upload responses to 502', async () => {
    const cookies = {
      [YOTO_ACCESS_TOKEN_COOKIE]: 'token',
      [YOTO_SCOPE_COOKIE]: 'user:content:manage',
    }
    installRouteGlobals(cookies)
    await fetchPersonalIcons('token', async () => ({ displayIcons: [] }))
    const searchHandler = (await import('../api/yoto/icons/community/search.get.ts')).default
    const importHandler = (await import('../api/yoto/icons/community/[id]/import.post.ts')).default
    const originalSearch = communityIconService.search
    const originalImport = communityIconService.importIcon
    try {
      communityIconService.search = async () => {
        throw new CommunityIconError('Search text is required.', 400)
      }
      await assert.rejects(() => searchHandler({}), (error: unknown) => {
        return (error as HttpError).statusCode === 400
      })

      communityIconService.importIcon = async () => {
        throw new YotoIconContractError('Yoto returned malformed icon data.')
      }
      await assert.rejects(() => importHandler({}), (error: unknown) => {
        return (error as HttpError).statusCode === 502
      })

      communityIconService.importIcon = async () => {
        throw new CommunityIconUploadOutcomeUncertainError()
      }
      await assert.rejects(() => importHandler({}), (error: unknown) => {
        const httpError = error as HttpError & { data?: { code?: string } }
        assert.match(httpError.message, /Do not retry blindly/)
        return httpError.statusCode === 502
          && httpError.data?.code === COMMUNITY_ICON_UPLOAD_OUTCOME_UNCERTAIN
      })
    }
    finally {
      communityIconService.search = originalSearch
      communityIconService.importIcon = originalImport
    }
  })

  it('forwards an upload AbortSignal through the Yoto request abstraction', async () => {
    installRouteGlobals()
    const controller = new AbortController()
    let forwardedSignal: AbortSignal | undefined
    ;(globalThis as Record<string, unknown>).$fetch = async (_url: string, options: { signal?: AbortSignal }) => {
      forwardedSignal = options.signal
      return { ok: true }
    }

    await fetchYotoApi('/media/displayIcons/user/me/upload', 'token', {
      method: 'POST',
      signal: controller.signal,
    })
    assert.equal(forwardedSignal, controller.signal)
  })
})
