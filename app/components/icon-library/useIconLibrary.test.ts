import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import {
  createIconStudioEditorState,
  isIconLibrarySelectionBlocked,
  resolveIconStudioSourceAttempt,
  shouldCloseIconLibraryAfterSelection,
  useIconLibrary,
} from './useIconLibrary.ts'
import { useCommunityIconSearch } from './useCommunityIconSearch.ts'
import { stageTrackIconAssignment } from '../../../shared/myo-editor/trackIconAssignment.ts'
import { COMMUNITY_ICON_UPLOAD_OUTCOME_UNCERTAIN } from '../../../shared/yoto/communityIconContract.ts'
import type { PlaylistTrack } from '../../../shared/myo-editor/types.ts'

const MEDIA_ID = 'a'.repeat(43)

function personalSourceBlob(): Blob {
  const bytes = new Uint8Array(24)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10])
  new DataView(bytes.buffer).setUint32(8, 13)
  bytes.set(new TextEncoder().encode('IHDR'), 12)
  new DataView(bytes.buffer).setUint32(16, 16)
  new DataView(bytes.buffer).setUint32(20, 16)
  return new Blob([bytes], { type: 'image/png' })
}

describe('icon library selection modes', () => {
  it('closes the existing single-track picker but keeps rapid assignment open', () => {
    assert.equal(shouldCloseIconLibraryAfterSelection(true, false), true)
    assert.equal(shouldCloseIconLibraryAfterSelection(true, true), false)
    assert.equal(shouldCloseIconLibraryAfterSelection(false, false), false)
  })

  it('blocks selection and target navigation during busy and recovery states', () => {
    assert.equal(isIconLibrarySelectionBlocked(false, false), false)
    assert.equal(isIconLibrarySelectionBlocked(true, false), true)
    assert.equal(isIconLibrarySelectionBlocked(false, true), true)
  })

  it('wires explicit My Icons recovery without selecting or assigning the uploaded icon', async () => {
    const component = await readFile(new URL('./IconLibraryModal.vue', import.meta.url), 'utf8')
    assert.match(component, /v-else-if="recoveryRequired"/)
    assert.match(component, />\s*Refresh My Icons\s*</)

    const uploadHandler = component.match(/async function onUpload[\s\S]*?\n}\n\nasync function onCommunityAccepted/)?.[0]
    assert.ok(uploadHandler)
    assert.doesNotMatch(uploadHandler, /chooseIcon|emit\(/)
  })

  it('exposes Edit as Copy only in standalone My Icons and keeps it outside assignment effects', async () => {
    const component = await readFile(new URL('./IconLibraryModal.vue', import.meta.url), 'utf8')
    assert.match(component, /v-if="!selectionMode"[\s\S]*?Edit as Copy/)
    assert.match(component, /Source unavailable/)
    assert.match(component, /:disabled="[^\"]*!icon\.url/)
  })

  it('wires the accessible copy and local-source actions to the tested transition seam', async () => {
    const modal = await readFile(new URL('./IconLibraryModal.vue', import.meta.url), 'utf8')
    const editor = await readFile(new URL('./IconStaticEditor.vue', import.meta.url), 'utf8')
    assert.match(modal, /:initial-source="editorSource"/)
    assert.match(modal, /:copy-mode="editorMode === 'copy'"/)
    assert.match(modal, /@source-replaced="clearPersonalSourceProvenance"/)
    assert.match(modal, /function clearPersonalSourceProvenance\(\)[\s\S]*?editorMode\.value = 'create'/)
    assert.match(modal, /v-if="sourceErrorCode === 'unavailable'"[\s\S]*?Refresh My Icons/)
    assert.match(modal, /v-else-if="sourceErrorCode === 'authentication'"[\s\S]*?href="\/api\/yoto\/auth\/login"[\s\S]*?>\s*Reconnect to Yoto\s*</)
    assert.match(modal, /v-else-if="sourceErrorCode === 'temporary'"[\s\S]*?Try again/)
    assert.doesNotMatch(modal, /sourceErrorCode === 'unsupported'/)
    assert.match(editor, /Edit a copy/)
    assert.match(editor, /Your original icon will not change/)
    assert.match(editor, /Upload copy/)
    assert.match(editor, /accept="image\/png,image\/jpeg,image\/webp"/)
    assert.match(editor, /URL\.revokeObjectURL/)
    assert.match(editor, /role="alert"/)
    assert.match(editor, /aria-label="Square crop area/)

    const localChangeHandler = editor.match(/async function onFileChange[\s\S]*?\n}/)?.[0]
    assert.ok(localChangeHandler)
    assert.match(localChangeHandler, /const replacement = await openSource\(file, file\.name\)/)
    assert.match(localChangeHandler, /if \(replacement\.personalProvenanceCleared\) emit\('sourceReplaced'\)/)
  })
})

describe('Icon Studio source transitions', () => {
  it('starts a Personal Icon copy with fresh Studio defaults', () => {
    assert.deepEqual(createIconStudioEditorState('personal'), {
      sourceKind: 'personal',
      source: null,
      zoom: 1,
      panX: 0,
      panY: 0,
      backgroundMode: 'transparent',
      backgroundColor: '#ffffff',
    })
  })

  it('preserves the current source, edits, and provenance after an invalid replacement', () => {
    const personalSource = { id: 'personal-source' }
    const current = {
      ...createIconStudioEditorState('personal', personalSource),
      zoom: 2.5,
      panX: 0.25,
      panY: -0.5,
      backgroundMode: 'solid' as const,
      backgroundColor: '#123456',
    }

    const transition = resolveIconStudioSourceAttempt(current, false)

    assert.equal(transition.state, current)
    assert.equal(transition.state.source, personalSource)
    assert.equal(transition.personalProvenanceCleared, false)
  })

  it('commits a valid local replacement with fresh defaults before clearing provenance', () => {
    const localSource = { id: 'local-source' }
    const current = {
      ...createIconStudioEditorState('personal', { id: 'personal-source' }),
      zoom: 2,
      panX: 0.5,
    }

    const transition = resolveIconStudioSourceAttempt(current, true, 'local', localSource)

    assert.deepEqual(transition.state, createIconStudioEditorState('local', localSource))
    assert.equal(transition.personalProvenanceCleared, true)
  })
})

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
  it('loads a Personal Icon Source with identity-only controls and refuses URL-less icons without a request', async () => {
    const requests: Array<{ url: string, options: unknown }> = []
    const restore = installNuxtStateTestHarness(async (url, options) => {
      requests.push({ url, options })
      return personalSourceBlob()
    })
    const icon = {
      mediaId: MEDIA_ID,
      displayIconId: 'personal-icon-1',
      url: 'https://media-secure-v2.api.yotoplay.com/icon.png',
      createdAt: null,
    }

    try {
      const library = useIconLibrary()
      const source = await library.loadPersonalIconSource(icon)
      assert.equal(source?.displayIconId, icon.displayIconId)
      assert.equal(source?.mediaId, MEDIA_ID)
      assert.equal(source?.filename, `personal-icon-${MEDIA_ID.slice(0, 12)}`)
      assert.equal(source?.blob.type, 'image/png')
      assert.equal(library.sourceStatus.value, 'ready')
      assert.equal(library.sourceErrorCode.value, null)
      assert.deepEqual(requests.map(request => request.url), ['/api/yoto/icons/source'])
      assert.deepEqual((requests[0]!.options as { query: unknown }).query, {
        displayIconId: icon.displayIconId,
        mediaId: MEDIA_ID,
      })
      assert.deepEqual(Object.keys(requests[0]!.options as object).sort(), ['query', 'responseType', 'signal'])

      assert.equal(await library.loadPersonalIconSource({ ...icon, url: null }), null)
      assert.equal(library.sourceStatus.value, 'error')
      assert.equal(library.sourceErrorCode.value, 'unavailable')
      assert.equal(
        library.sourceError.value,
        'This personal icon is no longer available. Refresh My Icons and try again.',
      )
      assert.equal(requests.length, 1)

      ;(globalThis as Record<string, unknown>).$fetch = async () => (
        new Blob([], { type: 'image/png' })
      )
      assert.equal(await library.loadPersonalIconSource(icon), null)
      assert.equal(library.sourceError.value, 'This personal icon can’t be edited in Icon Studio.')
      assert.equal(library.sourceErrorCode.value, 'unsupported')

      ;(globalThis as Record<string, unknown>).$fetch = async () => {
        throw Object.assign(new Error('temporary detail'), { statusCode: 502 })
      }
      assert.equal(await library.loadPersonalIconSource(icon), null)
      assert.equal(library.sourceErrorCode.value, 'temporary')
      assert.equal(library.sourceError.value, 'temporary detail')
    }
    finally {
      restore()
    }
  })

  it('treats a malformed or stale source identity as unavailable without revealing request details', async () => {
    const restore = installNuxtStateTestHarness(async () => {
      throw {
        data: {
          statusCode: 400,
          statusMessage: 'secret malformed identity detail',
        },
      }
    })

    try {
      const library = useIconLibrary()
      assert.equal(await library.loadPersonalIconSource({
        mediaId: MEDIA_ID,
        displayIconId: 'stale-personal-icon',
        url: 'https://media-secure-v2.api.yotoplay.com/stale.png',
        createdAt: null,
      }), null)
      assert.equal(library.sourceStatus.value, 'error')
      assert.equal(library.sourceErrorCode.value, 'unavailable')
      assert.equal(
        library.sourceError.value,
        'This personal icon is no longer available. Refresh My Icons and try again.',
      )
    }
    finally {
      restore()
    }
  })

  it('preserves authentication and permission recovery for rejected Personal Icon Source requests', async () => {
    for (const { statusCode, message } of [
      { statusCode: 401, message: 'Yoto session expired. Please reconnect.' },
      { statusCode: 403, message: 'Yoto API access denied. Check your app scopes.' },
    ]) {
      const restore = installNuxtStateTestHarness(async () => {
        throw { response: { status: statusCode }, data: { statusMessage: message } }
      })

      try {
        const library = useIconLibrary()
        assert.equal(await library.loadPersonalIconSource({
          mediaId: MEDIA_ID,
          displayIconId: 'personal-icon-auth',
          url: 'https://media-secure-v2.api.yotoplay.com/auth.png',
          createdAt: null,
        }), null)
        assert.equal(library.sourceStatus.value, 'error')
        assert.equal(library.sourceErrorCode.value, 'authentication')
        assert.equal(library.sourceError.value, message)
      }
      finally {
        restore()
      }
    }
  })

  it('aborts and suppresses cancelled, superseded, and account-invalidated sources', async () => {
    const first = deferred<Blob>()
    const second = deferred<Blob>()
    const third = deferred<Blob>()
    const signals: AbortSignal[] = []
    let requests = 0
    const restore = installNuxtStateTestHarness(async (_url, options) => {
      requests += 1
      signals.push((options as { signal: AbortSignal }).signal)
      return requests === 1 ? first.promise : requests === 2 ? second.promise : third.promise
    })
    const icon = (id: string) => ({
      mediaId: MEDIA_ID,
      displayIconId: id,
      url: `https://media-secure-v2.api.yotoplay.com/${id}.png`,
      createdAt: null,
    })

    try {
      const library = useIconLibrary()
      const oldLoad = library.loadPersonalIconSource(icon('old'))
      const newLoad = library.loadPersonalIconSource(icon('new'))
      assert.equal(signals[0]!.aborted, true)
      second.resolve(personalSourceBlob())
      assert.equal((await newLoad)?.displayIconId, 'new')
      first.resolve(personalSourceBlob())
      assert.equal(await oldLoad, null)
      assert.equal(library.sourceStatus.value, 'ready')

      const cancelled = library.loadPersonalIconSource(icon('cancelled'))
      library.cancelPersonalIconSource()
      assert.equal(signals[2]!.aborted, true)
      third.resolve(personalSourceBlob())
      assert.equal(await cancelled, null)
      assert.equal(library.sourceStatus.value, 'idle')

      const invalidatedResponse = deferred<Blob>()
      const originalFetch = (globalThis as Record<string, unknown>).$fetch
      ;(globalThis as Record<string, unknown>).$fetch = async (_url: string, options: unknown) => {
        signals.push((options as { signal: AbortSignal }).signal)
        return invalidatedResponse.promise
      }
      const invalidated = library.loadPersonalIconSource(icon('old-account'))
      library.invalidateAccountCache()
      assert.equal(signals[3]!.aborted, true)
      invalidatedResponse.resolve(personalSourceBlob())
      assert.equal(await invalidated, null)
      assert.equal(library.sourceStatus.value, 'idle')
      ;(globalThis as Record<string, unknown>).$fetch = originalFetch
    }
    finally {
      restore()
    }
  })

  it('uses exact Edit as Copy outcomes while retaining Ticket 02 recovery locks', async () => {
    const icon = {
      mediaId: MEDIA_ID,
      displayIconId: 'copy',
      url: 'https://example.com/copy.png',
      createdAt: null,
    }
    let disposition: 'created' | 'existing' = 'created'
    let refreshFails = false
    const calls: string[] = []
    const restore = installNuxtStateTestHarness(async (url) => {
      calls.push(url)
      if (url === '/api/yoto/icons/upload') return { icon, disposition }
      if (refreshFails) throw new Error('refresh failed')
      return { icons: [icon] }
    })

    try {
      const library = useIconLibrary()
      assert.equal(await library.uploadCopy(personalSourceBlob(), 'copy'), true)
      assert.equal(library.announcement.value, 'Copy added to My Icons.')

      disposition = 'existing'
      assert.equal(await library.uploadCopy(personalSourceBlob(), 'copy'), true)
      assert.equal(library.announcement.value, 'Yoto found and reused the identical icon.')

      disposition = 'created'
      refreshFails = true
      assert.equal(await library.uploadCopy(personalSourceBlob(), 'copy'), false)
      assert.equal(library.uploadStatus.value, 'accepted-refresh-failed')
      assert.deepEqual(library.acceptedIcon.value, icon)
      assert.equal(await library.uploadCopy(personalSourceBlob(), 'copy'), false)
      assert.deepEqual(calls, [
        '/api/yoto/icons/upload', '/api/yoto/icons/mine',
        '/api/yoto/icons/upload', '/api/yoto/icons/mine',
        '/api/yoto/icons/upload', '/api/yoto/icons/mine',
      ])
    }
    finally {
      restore()
    }
  })

  it('preserves the copy source and permits explicit retry after a definite upload rejection', async () => {
    const icon = {
      mediaId: MEDIA_ID,
      displayIconId: 'retry-copy',
      url: 'https://media-secure-v2.api.yotoplay.com/retry-copy.png',
      createdAt: null,
    }
    let uploadAttempts = 0
    const restore = installNuxtStateTestHarness(async (url) => {
      if (url === '/api/yoto/icons/source') return personalSourceBlob()
      if (url === '/api/yoto/icons/upload') {
        uploadAttempts += 1
        if (uploadAttempts === 1) {
          throw { statusCode: 415, data: { statusMessage: 'PNG rejected.' } }
        }
        return { icon, disposition: 'created' }
      }
      return { icons: [icon] }
    })

    try {
      const library = useIconLibrary()
      const source = await library.loadPersonalIconSource(icon)
      assert.ok(source)
      assert.equal(await library.uploadCopy(personalSourceBlob(), source.filename), false)
      assert.equal(library.uploadStatus.value, 'idle')
      assert.equal(library.errorMessage.value, 'PNG rejected.')
      assert.equal(library.sourceStatus.value, 'ready')
      assert.equal(source.displayIconId, icon.displayIconId)

      assert.equal(await library.uploadCopy(personalSourceBlob(), source.filename), true)
      assert.equal(uploadAttempts, 2)
      assert.equal(library.announcement.value, 'Copy added to My Icons.')
    }
    finally {
      restore()
    }
  })

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

  it('suppresses an accepted upload refresh that returns after account invalidation', async () => {
    const refreshResponse = deferred<{ icons: never[] }>()
    const icon = {
      mediaId: MEDIA_ID,
      displayIconId: 'old-account-icon',
      url: 'https://example.com/old-account.png',
      createdAt: null,
    }
    const restore = installNuxtStateTestHarness(async (url) => {
      if (url === '/api/yoto/icons/upload') return { icon, disposition: 'created' }
      return refreshResponse.promise
    })

    try {
      const library = useIconLibrary()
      const upload = library.upload(new Blob(['png']), 'icon')
      await Promise.resolve()
      library.invalidateAccountCache()
      refreshResponse.resolve({ icons: [] })

      assert.equal(await upload, false)
      assert.deepEqual(library.icons.value, [])
      assert.equal(library.status.value, 'idle')
      assert.equal(library.uploadStatus.value, 'idle')
      assert.equal(library.acceptedIcon.value, null)
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

  it('preserves an accepted icon and blocks another upload until an explicit recovery refresh', async () => {
    const icon = {
      mediaId: MEDIA_ID,
      displayIconId: 'accepted-icon',
      url: 'https://example.com/accepted-icon.png',
      createdAt: null,
    }
    const calls: string[] = []
    let refreshAttempts = 0
    const restore = installNuxtStateTestHarness(async (url) => {
      calls.push(url)
      if (url === '/api/yoto/icons/upload') return { icon, disposition: 'created' }
      refreshAttempts += 1
      if (refreshAttempts <= 2) throw { data: { statusMessage: 'Temporary refresh detail.' } }
      return { icons: [icon] }
    })

    try {
      const library = useIconLibrary()
      assert.equal(await library.upload(new Blob(['png']), 'icon'), false)
      assert.equal(library.uploadStatus.value, 'accepted-refresh-failed')
      assert.equal(library.recoveryRequired.value, true)
      assert.deepEqual(library.acceptedIcon.value, icon)
      assert.equal(
        library.errorMessage.value,
        'Yoto accepted the icon, but My Icons couldn’t refresh. Refresh My Icons before adding another icon.',
      )

      assert.equal(await library.upload(new Blob(['different png']), 'icon-2'), false)
      assert.deepEqual(calls, ['/api/yoto/icons/upload', '/api/yoto/icons/mine'])

      assert.equal(await library.load(), false)
      assert.equal(library.recoveryRequired.value, true)
      assert.equal(library.uploadStatus.value, 'accepted-refresh-failed')
      assert.deepEqual(library.acceptedIcon.value, icon)
      assert.equal(
        library.errorMessage.value,
        'Yoto accepted the icon, but My Icons couldn’t refresh. Refresh My Icons before adding another icon.',
      )

      assert.equal(await library.load(), true)
      assert.equal(library.recoveryRequired.value, false)
      assert.equal(library.uploadStatus.value, 'idle')
      assert.deepEqual(calls, [
        '/api/yoto/icons/upload',
        '/api/yoto/icons/mine',
        '/api/yoto/icons/mine',
        '/api/yoto/icons/mine',
      ])
    }
    finally {
      restore()
    }
  })

  it('blocks blind retry after an outcome-uncertain upload until an explicit recovery refresh', async () => {
    const calls: string[] = []
    let refreshAttempts = 0
    const restore = installNuxtStateTestHarness(async (url) => {
      calls.push(url)
      if (url === '/api/yoto/icons/upload') {
        throw Object.assign(new Error('Request timed out.'), { statusCode: 504 })
      }
      refreshAttempts += 1
      if (refreshAttempts === 1) throw { data: { statusMessage: 'Temporary refresh detail.' } }
      return { icons: [] }
    })

    try {
      const library = useIconLibrary()
      assert.equal(await library.upload(new Blob(['png']), 'icon'), false)
      assert.equal(library.uploadStatus.value, 'outcome-uncertain')
      assert.equal(library.recoveryRequired.value, true)
      assert.equal(library.acceptedIcon.value, null)
      assert.equal(
        library.errorMessage.value,
        'Yoto may have received this icon. Refresh My Icons before trying again.',
      )

      assert.equal(await library.upload(new Blob(['same png']), 'icon'), false)
      assert.deepEqual(calls, ['/api/yoto/icons/upload'])

      assert.equal(await library.load(), false)
      assert.equal(library.recoveryRequired.value, true)
      assert.equal(library.uploadStatus.value, 'outcome-uncertain')
      assert.equal(
        library.errorMessage.value,
        'Yoto may have received this icon. Refresh My Icons before trying again.',
      )

      assert.equal(await library.load(), true)
      assert.equal(library.recoveryRequired.value, false)
      assert.equal(library.uploadStatus.value, 'idle')
      assert.deepEqual(calls, [
        '/api/yoto/icons/upload',
        '/api/yoto/icons/mine',
        '/api/yoto/icons/mine',
      ])
    }
    finally {
      restore()
    }
  })

  it('refreshes again when recovery begins behind a pre-upload library request', async () => {
    const firstList = deferred<{ icons: never[] }>()
    let listRequests = 0
    const restore = installNuxtStateTestHarness(async (url) => {
      if (url === '/api/yoto/icons/upload') {
        throw Object.assign(new Error('Connection closed.'), { statusCode: 502 })
      }
      listRequests += 1
      if (listRequests === 1) return firstList.promise
      return { icons: [] }
    })

    try {
      const library = useIconLibrary()
      const preUploadLoad = library.load()
      assert.equal(await library.upload(new Blob(['png']), 'icon'), false)
      assert.equal(library.recoveryRequired.value, true)

      const recovery = library.load()
      firstList.resolve({ icons: [] })
      assert.equal(await preUploadLoad, true)
      assert.equal(await recovery, true)
      assert.equal(listRequests, 2)
      assert.equal(library.recoveryRequired.value, false)
    }
    finally {
      restore()
    }
  })

  it('keeps a definite upload rejection retryable', async () => {
    const icon = {
      mediaId: MEDIA_ID,
      displayIconId: 'retried-icon',
      url: 'https://example.com/retried-icon.png',
      createdAt: null,
    }
    const calls: string[] = []
    let uploadAttempts = 0
    const restore = installNuxtStateTestHarness(async (url) => {
      calls.push(url)
      if (url === '/api/yoto/icons/upload') {
        uploadAttempts += 1
        if (uploadAttempts === 1) {
          throw { statusCode: 415, data: { statusMessage: 'Content-Type must be image/png.' } }
        }
        return { icon, disposition: 'existing' }
      }
      return { icons: [icon] }
    })

    try {
      const library = useIconLibrary()
      assert.equal(await library.upload(new Blob(['invalid']), 'icon'), false)
      assert.equal(library.uploadStatus.value, 'idle')
      assert.equal(library.recoveryRequired.value, false)
      assert.equal(library.errorMessage.value, 'Content-Type must be image/png.')

      assert.equal(await library.upload(new Blob(['png']), 'icon'), true)
      assert.equal(library.uploadStatus.value, 'idle')
      assert.equal(library.newestMediaId.value, MEDIA_ID)
      assert.deepEqual(calls, [
        '/api/yoto/icons/upload',
        '/api/yoto/icons/upload',
        '/api/yoto/icons/mine',
      ])
    }
    finally {
      restore()
    }
  })

  it('treats a malformed upload success as uncertain without accepting its identity', async () => {
    const calls: string[] = []
    const restore = installNuxtStateTestHarness(async (url) => {
      calls.push(url)
      return {
        icon: {
          mediaId: MEDIA_ID,
          displayIconId: 'malformed-response',
          url: 'http://example.com/not-https.png',
          createdAt: null,
        },
        disposition: 'created',
      }
    })

    try {
      const library = useIconLibrary()
      assert.equal(await library.upload(new Blob(['png']), 'icon'), false)
      assert.equal(library.uploadStatus.value, 'outcome-uncertain')
      assert.equal(library.recoveryRequired.value, true)
      assert.equal(library.acceptedIcon.value, null)
      assert.equal(library.newestMediaId.value, null)
      assert.equal(
        library.errorMessage.value,
        'Yoto may have received this icon. Refresh My Icons before trying again.',
      )
      assert.deepEqual(calls, ['/api/yoto/icons/upload'])
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
      assert.equal(library.errorMessage.value, 'Do not retry blindly.')

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
