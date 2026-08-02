import type {
  PersonalIcon,
  PersonalIconListResponse,
  PersonalIconUploadResponse,
} from '#shared/yoto/iconContract'

type LibraryStatus = 'idle' | 'loading' | 'error' | 'ready'
type UploadStatus = 'idle' | 'uploading' | 'accepted-refresh-failed'

interface LoadOptions {
  refreshAfterCurrent?: boolean
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

export function useIconLibrary() {
  const icons = useState<PersonalIcon[]>('yoto-personal-icons', () => [])
  const status = useState<LibraryStatus>('yoto-personal-icons-status', () => 'idle')
  const uploadStatus = useState<UploadStatus>('yoto-personal-icons-upload-status', () => 'idle')
  const errorMessage = useState('yoto-personal-icons-error', () => '')
  const announcement = useState('yoto-personal-icons-announcement', () => '')
  const newestMediaId = useState<string | null>('yoto-personal-icons-newest', () => null)
  const generation = useState('yoto-personal-icons-generation', () => 0)
  const recoveryRequired = computed(() => uploadStatus.value === 'accepted-refresh-failed')

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
    if (status.value === 'loading') {
      const loaded = await waitForCurrentLoad()
      if (generation.value !== requestedGeneration) return false
      if (!options.refreshAfterCurrent) return loaded
    }

    // A disconnect can invalidate this request while it is in flight.
    const loadGeneration = generation.value
    const recovering = recoveryRequired.value
    status.value = 'loading'
    errorMessage.value = ''

    try {
      const response = await $fetch<PersonalIconListResponse>('/api/yoto/icons/mine')
      if (generation.value !== loadGeneration) return false
      icons.value = response.icons
      status.value = 'ready'
      if (recovering) uploadStatus.value = 'idle'
      return true
    }
    catch (error) {
      if (generation.value !== loadGeneration) return false
      status.value = 'error'
      errorMessage.value = extractIconError(error)
      return false
    }
  }

  async function upload(blob: Blob, filename: string): Promise<boolean> {
    if (uploadStatus.value !== 'idle') return false
    const uploadGeneration = generation.value
    uploadStatus.value = 'uploading'
    errorMessage.value = ''
    announcement.value = 'Uploading icon to Yoto.'

    try {
      const response = await $fetch<PersonalIconUploadResponse>('/api/yoto/icons/upload', {
        method: 'POST',
        query: { filename },
        headers: { 'Content-Type': 'image/png' },
        body: blob,
      })
      if (generation.value !== uploadGeneration) return false
      newestMediaId.value = response.icon.mediaId

      const refreshed = await load({ refreshAfterCurrent: true })
      if (generation.value !== uploadGeneration) return false
      if (!refreshed) {
        uploadStatus.value = 'accepted-refresh-failed'
        errorMessage.value = `Yoto accepted the icon, but the library could not be refreshed. Refresh the library or close My Icons before making another icon. ${errorMessage.value}`
        announcement.value = 'Yoto accepted the icon, but the library could not be refreshed.'
        return false
      }

      const verb = response.disposition === 'created' ? 'added' : 'found and reused'
      announcement.value = `Icon ${verb}. Your Yoto icon library is refreshed.`
      return true
    }
    catch (error) {
      if (generation.value !== uploadGeneration) return false
      errorMessage.value = extractIconError(error)
      announcement.value = 'Icon upload failed.'
      return false
    }
    finally {
      if (
        generation.value === uploadGeneration
        && uploadStatus.value === 'uploading'
      ) uploadStatus.value = 'idle'
    }
  }

  function resetSessionMessage() {
    errorMessage.value = ''
    announcement.value = ''
    newestMediaId.value = null
    if (uploadStatus.value !== 'uploading') uploadStatus.value = 'idle'
  }

  function invalidateAccountCache() {
    generation.value += 1
    icons.value = []
    status.value = 'idle'
    errorMessage.value = ''
    announcement.value = ''
    newestMediaId.value = null
    uploadStatus.value = 'idle'
  }

  return {
    icons,
    status,
    uploadStatus,
    errorMessage,
    announcement,
    newestMediaId,
    recoveryRequired,
    load,
    upload,
    resetSessionMessage,
    invalidateAccountCache,
  }
}
