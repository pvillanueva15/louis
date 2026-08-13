import type {
  PersonalIcon,
  PersonalIconListResponse,
  PersonalIconUploadResponse,
} from '#shared/yoto/iconContract'

type LibraryStatus = 'idle' | 'loading' | 'error' | 'ready'
type UploadStatus = 'idle' | 'uploading' | 'accepted-refresh-failed' | 'outcome-uncertain'
type SourceStatus = 'idle' | 'loading' | 'error' | 'ready'
type SourceErrorCode = 'authentication' | 'unavailable' | 'unsupported' | 'temporary'

export type IconStudioSourceKind = 'empty' | 'personal' | 'local'

export interface IconStudioEditorState<T = unknown> {
  sourceKind: IconStudioSourceKind
  source: T | null
  zoom: number
  panX: number
  panY: number
  backgroundMode: 'transparent' | 'solid'
  backgroundColor: string
}

export function createIconStudioEditorState<T = unknown>(
  sourceKind: IconStudioSourceKind = 'empty',
  source: T | null = null,
): IconStudioEditorState<T> {
  return {
    sourceKind,
    source,
    zoom: 1,
    panX: 0,
    panY: 0,
    backgroundMode: 'transparent',
    backgroundColor: '#ffffff',
  }
}

export function resolveIconStudioSourceAttempt<T>(
  current: IconStudioEditorState<T>,
  accepted: boolean,
  sourceKind: IconStudioSourceKind = 'local',
  source: T | null = current.source,
): { state: IconStudioEditorState<T>, personalProvenanceCleared: boolean } {
  if (!accepted) return { state: current, personalProvenanceCleared: false }
  return {
    state: createIconStudioEditorState(sourceKind, source),
    personalProvenanceCleared: current.sourceKind === 'personal' && sourceKind === 'local',
  }
}

export interface PersonalIconEditorSource {
  blob: Blob
  displayIconId: string
  mediaId: string
  filename: string
}

interface UploadMessages {
  created: string
  existing: string
}

interface LoadOptions {
  refreshAfterCurrent?: boolean
}

const ICON_UPLOAD_OUTCOME_UNCERTAIN_MESSAGE
  = 'Yoto may have received this icon. Refresh My Icons before trying again.'
const PERSONAL_ICON_UPLOAD_MEDIA_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/
const PERSONAL_ICON_SOURCE_MAX_BYTES = 64 * 1024
const PERSONAL_ICON_SOURCE_UNAVAILABLE_MESSAGE
  = 'This personal icon is no longer available. Refresh My Icons and try again.'
const PERSONAL_ICON_SOURCE_UNSUPPORTED_MESSAGE
  = 'This personal icon can’t be edited in Icon Studio.'
const DEFAULT_UPLOAD_MESSAGES: UploadMessages = {
  created: 'Icon added. Your Yoto icon library is refreshed.',
  existing: 'Icon found and reused. Your Yoto icon library is refreshed.',
}
const COPY_UPLOAD_MESSAGES: UploadMessages = {
  created: 'Copy added to My Icons.',
  existing: 'Yoto found and reused the identical icon.',
}

export function shouldCloseIconLibraryAfterSelection(
  selectionMode: boolean,
  rapidAssignment: boolean,
): boolean {
  return selectionMode && !rapidAssignment
}

export function isIconLibrarySelectionBlocked(
  modalBusy: boolean,
  recoveryRequired: boolean,
): boolean {
  return modalBusy || recoveryRequired
}

function extractIconError(error: unknown): string {
  const fetchError = error as {
    data?: { statusMessage?: string, message?: string }
    statusMessage?: string
    message?: string
  }

  return fetchError.data?.statusMessage
    ?? fetchError.data?.message
    ?? fetchError.statusMessage
    ?? fetchError.message
    ?? 'Something went wrong while talking to Yoto.'
}

function isDefiniteIconUploadFailure(error: unknown): boolean {
  const fetchError = error as {
    statusCode?: number
    status?: number
    data?: { statusCode?: number }
    response?: { status?: number }
  }
  const statusCode = fetchError.statusCode
    ?? fetchError.status
    ?? fetchError.data?.statusCode
    ?? fetchError.response?.status
  return typeof statusCode === 'number'
    && statusCode >= 400
    && statusCode < 500
    && statusCode !== 408
}

function classifyPersonalIconSourceError(error: unknown): SourceErrorCode {
  const fetchError = error as {
    statusCode?: number
    status?: number
    data?: { statusCode?: number }
    response?: { status?: number }
  }
  const statusCode = fetchError.statusCode
    ?? fetchError.status
    ?? fetchError.data?.statusCode
    ?? fetchError.response?.status
  if (statusCode === 401 || statusCode === 403) return 'authentication'
  if (statusCode === 400 || statusCode === 404) return 'unavailable'
  if (
    statusCode === 415
    || (error instanceof Error && error.message === PERSONAL_ICON_SOURCE_UNSUPPORTED_MESSAGE)
  ) return 'unsupported'
  return 'temporary'
}

function isNormalizedPersonalIconUrl(value: unknown): boolean {
  if (value === null) return true
  if (typeof value !== 'string') return false
  try {
    return new URL(value).protocol === 'https:'
  }
  catch {
    return false
  }
}

function isPersonalIconUploadResponse(value: unknown): value is PersonalIconUploadResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const response = value as Record<string, unknown>
  if (response.disposition !== 'created' && response.disposition !== 'existing') return false
  if (!response.icon || typeof response.icon !== 'object' || Array.isArray(response.icon)) return false

  const icon = response.icon as Record<string, unknown>
  return typeof icon.mediaId === 'string'
    && PERSONAL_ICON_UPLOAD_MEDIA_ID_PATTERN.test(icon.mediaId)
    && typeof icon.displayIconId === 'string'
    && icon.displayIconId.trim().length > 0
    && isNormalizedPersonalIconUrl(icon.url)
    && (icon.createdAt === null
      || (typeof icon.createdAt === 'string' && Number.isFinite(Date.parse(icon.createdAt))))
}

export function useIconLibrary() {
  const icons = useState<PersonalIcon[]>('yoto-personal-icons', () => [])
  const status = useState<LibraryStatus>('yoto-personal-icons-status', () => 'idle')
  const uploadStatus = useState<UploadStatus>('yoto-personal-icons-upload-status', () => 'idle')
  const errorMessage = useState('yoto-personal-icons-error', () => '')
  const announcement = useState('yoto-personal-icons-announcement', () => '')
  const newestMediaId = useState<string | null>('yoto-personal-icons-newest', () => null)
  const acceptedIcon = useState<PersonalIcon | null>('yoto-personal-icons-accepted-icon', () => null)
  const generation = useState('yoto-personal-icons-generation', () => 0)
  const sourceStatus = ref<SourceStatus>('idle')
  const sourceError = ref('')
  const sourceErrorCode = ref<SourceErrorCode | null>(null)
  let sourceRequest = 0
  let sourceController: AbortController | null = null
  const recoveryRequired = computed(() => (
    uploadStatus.value === 'accepted-refresh-failed'
    || uploadStatus.value === 'outcome-uncertain'
  ))

  function waitForCurrentLoad(): Promise<boolean> {
    if (status.value !== 'loading') return Promise.resolve(status.value === 'ready')

    // Shared status lets every composable instance join the same request without
    // storing a non-serializable Promise in Nuxt state.
    return new Promise((resolve) => {
      const stop = watch(status, (nextStatus) => {
        if (nextStatus === 'loading') return
        stop()
        resolve(nextStatus === 'ready')
      })
    })
  }

  async function load(options: LoadOptions = {}): Promise<boolean> {
    const requestedGeneration = generation.value
    const recoveringAtRequest = recoveryRequired.value
    if (status.value === 'loading') {
      const loaded = await waitForCurrentLoad()
      if (generation.value !== requestedGeneration) return false
      if (!options.refreshAfterCurrent && !recoveringAtRequest) return loaded
    }

    // A disconnect can invalidate this request while it is in flight.
    const loadGeneration = generation.value
    const recovering = recoveryRequired.value
    const recoveryErrorMessage = recovering ? errorMessage.value : ''
    status.value = 'loading'
    errorMessage.value = ''

    try {
      const response = await $fetch<PersonalIconListResponse>('/api/yoto/icons/mine')
      if (generation.value !== loadGeneration) return false
      icons.value = response.icons
      status.value = 'ready'
      if (recovering) {
        uploadStatus.value = 'idle'
        acceptedIcon.value = null
        announcement.value = 'My Icons refreshed. You can upload another icon.'
      }
      return true
    }
    catch (error) {
      if (generation.value !== loadGeneration) return false
      status.value = 'error'
      errorMessage.value = recovering ? recoveryErrorMessage : extractIconError(error)
      return false
    }
  }

  async function uploadWithMessages(
    blob: Blob,
    filename: string,
    messages: UploadMessages,
  ): Promise<boolean> {
    if (uploadStatus.value !== 'idle') return false
    const uploadGeneration = generation.value
    uploadStatus.value = 'uploading'
    errorMessage.value = ''
    announcement.value = 'Uploading icon to Yoto.'

    try {
      const response = await $fetch<unknown>('/api/yoto/icons/upload', {
        method: 'POST',
        query: { filename },
        headers: { 'Content-Type': 'image/png' },
        body: blob,
      })
      if (generation.value !== uploadGeneration) return false
      if (!isPersonalIconUploadResponse(response)) {
        throw new Error('Yoto returned a malformed icon upload response.')
      }
      return await refreshAcceptedIcon(response, uploadGeneration, messages)
    }
    catch (error) {
      if (generation.value !== uploadGeneration) return false
      if (isDefiniteIconUploadFailure(error)) {
        errorMessage.value = extractIconError(error)
        announcement.value = 'Icon upload failed. Correct the problem and try again.'
      }
      else {
        uploadStatus.value = 'outcome-uncertain'
        errorMessage.value = ICON_UPLOAD_OUTCOME_UNCERTAIN_MESSAGE
        announcement.value = ICON_UPLOAD_OUTCOME_UNCERTAIN_MESSAGE
      }
      return false
    }
    finally {
      if (
        generation.value === uploadGeneration
        && uploadStatus.value === 'uploading'
      ) uploadStatus.value = 'idle'
    }
  }

  async function upload(blob: Blob, filename: string): Promise<boolean> {
    return await uploadWithMessages(blob, filename, DEFAULT_UPLOAD_MESSAGES)
  }

  async function uploadCopy(blob: Blob, filename: string): Promise<boolean> {
    return await uploadWithMessages(blob, filename, COPY_UPLOAD_MESSAGES)
  }

  async function refreshAcceptedIcon(
    response: PersonalIconUploadResponse,
    acceptedGeneration: number,
    messages: UploadMessages = DEFAULT_UPLOAD_MESSAGES,
  ): Promise<boolean> {
    acceptedIcon.value = response.icon
    newestMediaId.value = response.icon.mediaId
    const refreshed = await load({ refreshAfterCurrent: true })
    if (generation.value !== acceptedGeneration) return false
    if (!refreshed) {
      uploadStatus.value = 'accepted-refresh-failed'
      errorMessage.value = 'Yoto accepted the icon, but My Icons couldn’t refresh. Refresh My Icons before adding another icon.'
      announcement.value = errorMessage.value
      return false
    }

    acceptedIcon.value = null
    announcement.value = messages[response.disposition]
    return true
  }

  function cancelPersonalIconSource(): void {
    sourceRequest += 1
    sourceController?.abort()
    sourceController = null
    sourceStatus.value = 'idle'
    sourceError.value = ''
    sourceErrorCode.value = null
  }

  async function loadPersonalIconSource(icon: PersonalIcon): Promise<PersonalIconEditorSource | null> {
    cancelPersonalIconSource()
    if (!icon.url) {
      sourceStatus.value = 'error'
      sourceError.value = PERSONAL_ICON_SOURCE_UNAVAILABLE_MESSAGE
      sourceErrorCode.value = 'unavailable'
      return null
    }

    const request = ++sourceRequest
    const requestGeneration = generation.value
    const controller = new AbortController()
    sourceController = controller
    sourceStatus.value = 'loading'
    sourceErrorCode.value = null

    try {
      const blob = await $fetch<Blob>('/api/yoto/icons/source', {
        query: { displayIconId: icon.displayIconId, mediaId: icon.mediaId },
        responseType: 'blob',
        signal: controller.signal,
      })
      if (request !== sourceRequest || requestGeneration !== generation.value) return null
      if (
        !(blob instanceof Blob)
        || blob.type !== 'image/png'
        || blob.size < 1
        || blob.size > PERSONAL_ICON_SOURCE_MAX_BYTES
      ) {
        throw new Error(PERSONAL_ICON_SOURCE_UNSUPPORTED_MESSAGE)
      }
      if (request !== sourceRequest || requestGeneration !== generation.value) return null

      const session = {
        blob,
        displayIconId: icon.displayIconId,
        mediaId: icon.mediaId,
        filename: `personal-icon-${icon.mediaId.slice(0, 12)}`,
      }
      sourceStatus.value = 'ready'
      sourceErrorCode.value = null
      sourceController = null
      return session
    }
    catch (error) {
      if (request !== sourceRequest || requestGeneration !== generation.value) return null
      sourceController = null
      sourceStatus.value = 'error'
      const errorCode = classifyPersonalIconSourceError(error)
      sourceErrorCode.value = errorCode
      sourceError.value = errorCode === 'unavailable'
        ? PERSONAL_ICON_SOURCE_UNAVAILABLE_MESSAGE
        : error instanceof Error && error.message === PERSONAL_ICON_SOURCE_UNSUPPORTED_MESSAGE
          ? PERSONAL_ICON_SOURCE_UNSUPPORTED_MESSAGE
          : extractIconError(error)
      return null
    }
  }

  async function acceptImportedIcon(response: PersonalIconUploadResponse): Promise<boolean> {
    if (uploadStatus.value !== 'idle') return false
    const acceptedGeneration = generation.value
    uploadStatus.value = 'uploading'
    errorMessage.value = ''
    announcement.value = 'Refreshing My Icons after community import.'
    try {
      return await refreshAcceptedIcon(response, acceptedGeneration)
    }
    finally {
      if (
        generation.value === acceptedGeneration
        && uploadStatus.value === 'uploading'
      ) uploadStatus.value = 'idle'
    }
  }

  function markCommunityUploadOutcomeUncertain(message: string): void {
    uploadStatus.value = 'outcome-uncertain'
    errorMessage.value = message
    announcement.value = 'The community icon upload outcome is uncertain. Refresh My Icons before trying again.'
  }

  function resetSessionMessage() {
    if (recoveryRequired.value) return
    errorMessage.value = ''
    announcement.value = ''
    newestMediaId.value = null
    acceptedIcon.value = null
    if (uploadStatus.value !== 'uploading') uploadStatus.value = 'idle'
  }

  async function openSession(): Promise<boolean> {
    resetSessionMessage()
    return await load()
  }

  function invalidateAccountCache() {
    generation.value += 1
    icons.value = []
    status.value = 'idle'
    errorMessage.value = ''
    announcement.value = ''
    newestMediaId.value = null
    acceptedIcon.value = null
    uploadStatus.value = 'idle'
  }

  watch(generation, () => cancelPersonalIconSource(), { flush: 'sync' })

  return {
    icons,
    status,
    uploadStatus,
    errorMessage,
    announcement,
    newestMediaId,
    acceptedIcon,
    recoveryRequired,
    sourceStatus,
    sourceError,
    sourceErrorCode,
    load,
    upload,
    uploadCopy,
    loadPersonalIconSource,
    cancelPersonalIconSource,
    acceptImportedIcon,
    markCommunityUploadOutcomeUncertain,
    resetSessionMessage,
    openSession,
    invalidateAccountCache,
  }
}
