import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { useIconLibrary } from './useIconLibrary.ts'
import { useCommunityIconSearch } from './useCommunityIconSearch.ts'
import { stageTrackIconAssignment } from '../../../shared/myo-editor/trackIconAssignment.ts'
import { COMMUNITY_ICON_UPLOAD_OUTCOME_UNCERTAIN } from '../../../shared/yoto/communityIconContract.ts'
import type { PlaylistTrack } from '../../../shared/myo-editor/types.ts'

const MEDIA_ID = 'a'.repeat(43)

interface TestRef<T> {
  value: T
  listeners: Set<(value: T) => void>
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function installNuxtStateTestHarness(
  fetcher: (url: string, options?: unknown) => Promise<unknown>,
) {
  const globals = globalThis as Record<string, unknown>
  const names = ['useState', 'ref', 'computed', 'watch', '$fetch'] as const
  const originals = new Map(names.map(name => [
    name,
    Object.getOwnPropertyDescriptor(globalThis, name),
  ]))
  const states = new Map<string, TestRef<unknown>>()

  globals.useState = (key: string, init: () => unknown) => {
    const existing = states.get(key)
    if (existing) return existing
    let current = init()
    const listeners = new Set<(value: unknown) => void>()
    const state = {
      get value() {
        return current
      },
      set value(value: unknown) {
        current = value
        for (const listener of listeners) listener(value)
      },
      listeners,
    }
    states.set(key, state)
    return state
  }
  globals.computed = (getter: () => unknown) => ({
    get value() {
      return getter()
    },
  })
  globals.ref = (value: unknown) => ({ value })
  globals.watch = (source: TestRef<unknown>, callback: (value: unknown) => void) => {
    source.listeners.add(callback)
    return () => source.listeners.delete(callback)
  }
  globals.$fetch = fetcher

  return () => {
    for (const name of names) {
      const descriptor = originals.get(name)
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete globals[name]
    }
  }
}

describe('shared personal icon library state', () => {
  it('joins an in-flight load and rejects its stale result after invalidation', async () => {
    const response = deferred<{ icons: never[] }>()
    let requests = 0
    const restore = installNuxtStateTestHarness(async () => {
      requests += 1
      return response.promise
    })

    try {
      const preview = useIconLibrary()
      const modal = useIconLibrary()
      const previewLoad = preview.load()
      const modalLoad = modal.load()

      assert.equal(requests, 1)
      modal.invalidateAccountCache()
      response.resolve({ icons: [] })
      assert.deepEqual(await Promise.all([previewLoad, modalLoad]), [false, false])
      assert.deepEqual(preview.icons.value, [])
      assert.equal(preview.status.value, 'idle')
    }
    finally {
      restore()
    }
  })

  it('waits for a preview load before the required post-upload refresh', async () => {
    const firstList = deferred<{ icons: never[] }>()
    const refreshedList = deferred<{ icons: Array<{
      mediaId: string
      displayIconId: string
      url: string
      createdAt: null
    }> }>()
    let listRequests = 0
    const icon = {
      mediaId: MEDIA_ID,
      displayIconId: 'personal-icon-1',
      url: 'https://example.com/icon.png',
      createdAt: null,
    }
    const restore = installNuxtStateTestHarness(async (url) => {
      if (url === '/api/yoto/icons/upload') {
        return { icon, disposition: 'created' }
      }
      listRequests += 1
      return listRequests === 1 ? firstList.promise : refreshedList.promise
    })

    try {
      const preview = useIconLibrary()
      const modal = useIconLibrary()
      const previewLoad = preview.load()
      const upload = modal.upload(new Blob(['png']), 'icon')

      assert.equal(listRequests, 1)
      firstList.resolve({ icons: [] })
      await previewLoad
      await Promise.resolve()
      assert.equal(listRequests, 2)
      refreshedList.resolve({ icons: [icon] })

      assert.equal(await upload, true)
      assert.deepEqual(preview.icons.value, [icon])
    }
    finally {
      restore()
    }
  })

  it('suppresses an upload response that returns after account invalidation', async () => {
    const uploadResponse = deferred<{
      icon: {
        mediaId: string
        displayIconId: string
        url: string
        createdAt: null
      }
      disposition: 'created'
    }>()
    let listRequests = 0
    const icon = {
      mediaId: MEDIA_ID,
      displayIconId: 'old-account-icon',
      url: 'https://example.com/old-account.png',
      createdAt: null,
    }
    const restore = installNuxtStateTestHarness(async (url) => {
      if (url === '/api/yoto/icons/upload') return uploadResponse.promise
      listRequests += 1
      return { icons: [icon] }
    })

    try {
      const library = useIconLibrary()
      const upload = library.upload(new Blob(['png']), 'icon')
      library.invalidateAccountCache()
      uploadResponse.resolve({ icon, disposition: 'created' })

      assert.equal(await upload, false)
      assert.equal(listRequests, 0)
      assert.deepEqual(library.icons.value, [])
      assert.equal(library.status.value, 'idle')
      assert.equal(library.uploadStatus.value, 'idle')
      assert.equal(library.newestMediaId.value, null)
      assert.equal(library.errorMessage.value, '')
      assert.equal(library.announcement.value, '')
    }
    finally {
      restore()
    }
  })

  it('refreshes My Icons after an externally accepted community upload', async () => {
    const icon = {
      mediaId: MEDIA_ID,
      displayIconId: 'community-copy',
      url: 'https://example.com/community-copy.png',
      createdAt: null,
    }
    const calls: string[] = []
    const restore = installNuxtStateTestHarness(async (url) => {
      calls.push(url)
      return { icons: [icon] }
    })

    try {
      const library = useIconLibrary()
      assert.equal(await library.acceptImportedIcon({ icon, disposition: 'created' }), true)
      assert.deepEqual(library.icons.value, [icon])
      assert.equal(library.newestMediaId.value, MEDIA_ID)
      assert.deepEqual(calls, ['/api/yoto/icons/mine'])
    }
    finally {
      restore()
    }
  })

  it('preserves uncertain recovery through close and failed reopen, then clears it after a successful reopen refresh', async () => {
    const icon = {
      mediaId: MEDIA_ID,
      displayIconId: 'possibly-uploaded',
      url: 'https://example.com/possibly-uploaded.png',
      createdAt: null,
    }
    const communityIcon = {
      id: '12583',
      page: 1,
      title: 'Cat',
      tags: ['animals'],
      creator: 'curiouscat',
      downloads: 42,
      previewUrl: '/api/yoto/icons/community/12583/preview',
      sourceUrl: 'https://www.yotoicons.com/icons?tag=cat&sort=popular&type=singles&page=1',
    }
    const calls: string[] = []
    const restore = installNuxtStateTestHarness(async (url) => {
      calls.push(url)
      if (url.endsWith('/search')) return { query: 'cat', page: 1, nextPage: null, icons: [communityIcon] }
      if (calls.filter(call => call === '/api/yoto/icons/mine').length === 1) {
        throw { data: { statusMessage: 'Refresh failed.' } }
      }
      return { icons: [icon] }
    })

    try {
      const library = useIconLibrary()
      library.markCommunityUploadOutcomeUncertain('Do not retry blindly.')
      assert.equal(library.recoveryRequired.value, true)
      assert.equal(library.errorMessage.value, 'Do not retry blindly.')

      library.resetSessionMessage()
      assert.equal(library.recoveryRequired.value, true)
      assert.equal(library.errorMessage.value, 'Do not retry blindly.')

      assert.equal(await library.openSession(), false)
      assert.equal(library.recoveryRequired.value, true)
      assert.equal(library.errorMessage.value, 'Refresh failed.')

      const community = useCommunityIconSearch()
      community.query.value = 'cat'
      assert.equal(await community.search(), true)
      assert.equal(await community.importIcon(communityIcon), null)
      assert.equal(calls.some(call => call.endsWith('/import')), false)

      assert.equal(await library.openSession(), true)
      assert.deepEqual(library.icons.value, [icon])
      assert.equal(library.recoveryRequired.value, false)
      assert.equal(library.uploadStatus.value, 'idle')
      assert.match(library.announcement.value, /refreshed/)
      assert.deepEqual(calls, [
        '/api/yoto/icons/mine',
        '/api/yoto/icons/community/search',
        '/api/yoto/icons/mine',
      ])
    }
    finally {
      restore()
    }
  })
})

function editableTrack(): PlaylistTrack {
  return {
    id: 'row-1',
    title: 'Track',
    subtitle: 'Yoto upload',
    thumbnailUrl: '',
    source: 'yoto-upload',
    chapterKey: 'stable-chapter',
    trackKey: 'stable-track',
    rawIconState: { kind: 'absent' },
    chapterRawIconState: { kind: 'present', value: 'yoto:#chapter' },
    chapterTrackCount: 2,
  }
}

describe('explicit community icon search and import state', () => {
  it('disables empty search, waits for submit, and protects results from stale requests', async () => {
    const cat = deferred<{ query: string, page: number, nextPage: number | null, icons: never[] }>()
    const dog = deferred<{ query: string, page: number, nextPage: number | null, icons: never[] }>()
    let requests = 0
    const restore = installNuxtStateTestHarness(async (_url, options) => {
      requests += 1
      const q = (options as { query: { q: string } }).query.q
      return q === 'cat' ? cat.promise : dog.promise
    })

    try {
      const community = useCommunityIconSearch()
      assert.equal(requests, 0)
      assert.equal(community.status.value, 'idle')
      assert.equal(community.canSearch.value, false)

      community.query.value = '   '
      assert.equal(community.canSearch.value, false)

      community.query.value = 'cat'
      assert.equal(community.canSearch.value, true)
      const first = community.search()
      community.query.value = 'dog'
      const second = community.search()
      dog.resolve({ query: 'dog', page: 1, nextPage: null, icons: [] })
      assert.equal(await second, true)
      cat.resolve({ query: 'cat', page: 1, nextPage: null, icons: [] })
      assert.equal(await first, false)
      assert.equal(community.submittedQuery.value, 'dog')
      assert.equal(community.status.value, 'ready')
      assert.equal(requests, 2)
    }
    finally {
      restore()
    }
  })

  it('loads and deduplicates later pages while keeping the submitted query stable', async () => {
    const icon = (id: string, page: number) => ({
      id,
      page,
      title: `Cat ${id}`,
      tags: ['animals'],
      creator: 'curiouscat',
      downloads: 1,
      previewUrl: `/api/yoto/icons/community/${id}/preview`,
      sourceUrl: `https://www.yotoicons.com/icons?tag=cat&sort=popular&type=singles&page=${page}`,
    })
    const requests: Array<{ q: string, page?: number }> = []
    const restore = installNuxtStateTestHarness(async (_url, options) => {
      const request = (options as { query: { q: string, page?: number } }).query
      requests.push(request)
      if (request.page === 2) {
        return { query: 'cat', page: 2, nextPage: null, icons: [icon('1', 2), icon('2', 2)] }
      }
      return { query: 'cat', page: 1, nextPage: 2, icons: [icon('1', 1)] }
    })

    try {
      const community = useCommunityIconSearch()
      community.query.value = 'cat'
      assert.equal(await community.search(), true)
      community.query.value = 'a different unsent query'
      assert.equal(await community.loadMore(), true)
      assert.deepEqual(community.icons.value.map(result => result.id), ['1', '2'])
      assert.equal(community.nextPage.value, null)
      assert.equal(await community.loadMore(), false)
      assert.deepEqual(requests, [{ q: 'cat' }, { q: 'cat', page: 2 }])
    }
    finally {
      restore()
    }
  })

  it('preserves current results and allows retry when loading another page fails', async () => {
    let requests = 0
    const firstIcon = {
      id: '1',
      page: 1,
      title: 'Cat',
      tags: ['animals'],
      creator: 'curiouscat',
      downloads: null,
      previewUrl: '/api/yoto/icons/community/1/preview',
      sourceUrl: 'https://www.yotoicons.com/icons?tag=cat&sort=popular&type=singles&page=1',
    }
    const restore = installNuxtStateTestHarness(async () => {
      requests += 1
      if (requests === 1) {
        return { query: 'cat', page: 1, nextPage: 2, icons: [firstIcon] }
      }
      throw { data: { statusMessage: 'Yotoicons is temporarily unavailable.' } }
    })

    try {
      const community = useCommunityIconSearch()
      community.query.value = 'cat'
      assert.equal(await community.search(), true)
      assert.equal(await community.loadMore(), false)
      assert.deepEqual(community.icons.value, [firstIcon])
      assert.equal(community.nextPage.value, 2)
      assert.equal(community.status.value, 'ready')
      assert.equal(community.errorMessage.value, 'Yotoicons is temporarily unavailable.')
    }
    finally {
      restore()
    }
  })

  it('reports explicit-search errors and clears them on reset', async () => {
    const restore = installNuxtStateTestHarness(async () => {
      throw { data: { statusMessage: 'Yotoicons markup changed.' } }
    })
    try {
      const community = useCommunityIconSearch()
      community.query.value = 'cat'
      assert.equal(await community.search(), false)
      assert.equal(community.status.value, 'error')
      assert.equal(community.errorMessage.value, 'Yotoicons markup changed.')
      community.reset()
      assert.equal(community.status.value, 'idle')
      assert.equal(community.errorMessage.value, '')
      assert.deepEqual(community.icons.value, [])
    }
    finally {
      restore()
    }
  })

  it('keeps a newer empty submission error when an older search later succeeds', async () => {
    const pending = deferred<{ query: string, page: number, nextPage: number | null, icons: never[] }>()
    const restore = installNuxtStateTestHarness(async () => pending.promise)
    try {
      const community = useCommunityIconSearch()
      community.query.value = 'cat'
      const oldSearch = community.search()
      community.query.value = '   '
      assert.equal(await community.search(), false)
      assert.equal(community.status.value, 'error')
      assert.equal(community.errorMessage.value, 'Enter a tag or title to search Yotoicons.')

      pending.resolve({ query: 'cat', page: 1, nextPage: null, icons: [] })
      assert.equal(await oldSearch, false)
      assert.equal(community.status.value, 'error')
      assert.equal(community.submittedQuery.value, '')
      assert.deepEqual(community.icons.value, [])
    }
    finally {
      restore()
    }
  })

  it('imports, refreshes My Icons, and stages only the returned mediaId at stable keys', async () => {
    const personalIcon = {
      mediaId: MEDIA_ID,
      displayIconId: 'imported-personal-icon',
      url: 'https://example.com/personal-icon.png',
      createdAt: null,
    }
    const communityIcon = {
      id: '12583',
      page: 1,
      title: 'Cat',
      tags: ['animals'],
      creator: 'curiouscat',
      downloads: 42,
      previewUrl: '/api/yoto/icons/community/12583/preview',
      sourceUrl: 'https://www.yotoicons.com/icons?tag=cat&sort=popular&type=singles&page=1',
    }
    const calls: Array<{ url: string, options: unknown }> = []
    const restore = installNuxtStateTestHarness(async (url, options) => {
      calls.push({ url, options })
      if (url.endsWith('/search')) return { query: 'cat', page: 1, nextPage: null, icons: [communityIcon] }
      if (url.endsWith('/import')) return { icon: personalIcon, disposition: 'created' }
      if (url === '/api/yoto/icons/mine') return { icons: [personalIcon] }
      throw new Error(`Unexpected request: ${url}`)
    })

    try {
      const community = useCommunityIconSearch()
      const library = useIconLibrary()
      community.query.value = 'cat'
      assert.equal(await community.search(), true)
      const accepted = await community.importIcon(communityIcon)
      assert.ok(accepted)
      assert.equal(await library.acceptImportedIcon(accepted), true)

      const track = editableTrack()
      const staged = stageTrackIconAssignment([], track, {
        mode: 'icon',
        mediaId: accepted.icon.mediaId,
        previewUrl: accepted.icon.url,
      })
      assert.equal(staged[0]?.mutation.chapterKey, 'stable-chapter')
      assert.equal(staged[0]?.mutation.trackKey, 'stable-track')
      assert.equal(staged[0]?.mutation.mode === 'icon' && staged[0].mutation.mediaId, MEDIA_ID)
      assert.deepEqual(library.icons.value, [personalIcon])
      assert.deepEqual(calls.map(call => call.url), [
        '/api/yoto/icons/community/search',
        '/api/yoto/icons/community/12583/import',
        '/api/yoto/icons/mine',
      ])
      assert.deepEqual((calls[1]?.options as { body: unknown }).body, { query: 'cat', page: 1 })
      assert.equal(calls.some(call => /\/api\/yoto\/content|save-jobs|youtube|audio/.test(call.url)), false)
    }
    finally {
      restore()
    }
  })

  it('surfaces an outcome-uncertain upload and prevents another Add in the modal session', async () => {
    const communityIcon = {
      id: '12583',
      page: 1,
      title: 'Cat',
      tags: ['animals'],
      creator: 'curiouscat',
      downloads: 42,
      previewUrl: '/api/yoto/icons/community/12583/preview',
      sourceUrl: 'https://www.yotoicons.com/icons?tag=cat&sort=popular&type=singles&page=1',
    }
    const message = 'The Yoto upload may have succeeded. Do not retry blindly; close and reopen the icon library to refresh My Icons before trying again.'
    const calls: string[] = []
    const restore = installNuxtStateTestHarness(async (url) => {
      calls.push(url)
      if (url.endsWith('/search')) return { query: 'cat', page: 1, nextPage: null, icons: [communityIcon] }
      throw {
        data: {
          statusMessage: message,
          data: { code: COMMUNITY_ICON_UPLOAD_OUTCOME_UNCERTAIN },
        },
      }
    })

    try {
      const community = useCommunityIconSearch()
      const library = useIconLibrary()
      community.query.value = 'cat'
      assert.equal(await community.search(), true)
      assert.equal(await community.importIcon(communityIcon), null)
      assert.equal(community.uploadOutcomeUncertain.value, true)
      assert.equal(community.errorMessage.value, message)
      assert.equal(library.recoveryRequired.value, true)
      assert.equal(library.errorMessage.value, message)

      assert.equal(await community.importIcon(communityIcon), null)
      assert.deepEqual(calls, [
        '/api/yoto/icons/community/search',
        '/api/yoto/icons/community/12583/import',
      ])
    }
    finally {
      restore()
    }
  })

  it('surfaces definite 401 and 403 upload rejections without setting a recovery lock', async () => {
    for (const statusCode of [401, 403]) {
      const communityIcon = {
        id: '12583',
        page: 1,
        title: 'Cat',
        tags: ['animals'],
        creator: 'curiouscat',
        downloads: 42,
        previewUrl: '/api/yoto/icons/community/12583/preview',
        sourceUrl: 'https://www.yotoicons.com/icons?tag=cat&sort=popular&type=singles&page=1',
      }
      const message = statusCode === 401
        ? 'Yoto session expired. Please reconnect.'
        : 'Yoto API access denied. Check your app scopes.'
      const calls: string[] = []
      const restore = installNuxtStateTestHarness(async (url) => {
        calls.push(url)
        if (url.endsWith('/search')) return { query: 'cat', page: 1, nextPage: null, icons: [communityIcon] }
        throw { data: { statusCode, statusMessage: message } }
      })

      try {
        const community = useCommunityIconSearch()
        const library = useIconLibrary()
        community.query.value = 'cat'
        assert.equal(await community.search(), true)
        assert.equal(await community.importIcon(communityIcon), null)
        assert.equal(community.errorMessage.value, message)
        assert.equal(community.uploadOutcomeUncertain.value, false)
        assert.equal(library.recoveryRequired.value, false)

        assert.equal(await community.importIcon(communityIcon), null)
        assert.deepEqual(calls, [
          '/api/yoto/icons/community/search',
          '/api/yoto/icons/community/12583/import',
          '/api/yoto/icons/community/12583/import',
        ])
      }
      finally {
        restore()
      }
    }
  })

  it('renders preview, title, tags, creator, downloads, source link, and the upload boundary', async () => {
    const component = await readFile(new URL('./CommunityIconSearch.vue', import.meta.url), 'utf8')
    for (const binding of [
      ':src="icon.previewUrl"',
      '{{ icon.title }}',
      "icon.tags.join(' · ')",
      'by {{ icon.creator }}',
      '{{ icon.downloads }} downloads',
      ':href="icon.sourceUrl"',
      'Add to My Icons & use',
      'Load more',
      'Showing {{ icons.length }} icons',
      '25 at a time',
      'cannot undo that Yoto library upload',
    ]) assert.match(component, new RegExp(binding.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  })

})
