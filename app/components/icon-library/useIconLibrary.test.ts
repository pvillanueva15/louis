import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { useIconLibrary } from './useIconLibrary.ts'

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
  const names = ['useState', 'computed', 'watch', '$fetch'] as const
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
})
