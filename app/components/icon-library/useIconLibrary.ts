import type {
  PersonalIcon,
  PersonalIconListResponse,
  PersonalIconUploadResponse,
} from '#shared/yoto/iconContract'

type LibraryStatus = 'idle' | 'loading' | 'error' | 'ready'
type UploadStatus = 'idle' | 'uploading' | 'accepted-refresh-failed'

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
  const icons = ref<PersonalIcon[]>([])
  const status = ref<LibraryStatus>('idle')
  const uploadStatus = ref<UploadStatus>('idle')
  const errorMessage = ref('')
  const announcement = ref('')
  const newestMediaId = ref<string | null>(null)
  const recoveryRequired = computed(() => uploadStatus.value === 'accepted-refresh-failed')

  async function load(): Promise<boolean> {
    const recovering = recoveryRequired.value
    status.value = 'loading'
    errorMessage.value = ''

    try {
      const response = await $fetch<PersonalIconListResponse>('/api/yoto/icons/mine')
      icons.value = response.icons
      status.value = 'ready'
      if (recovering) uploadStatus.value = 'idle'
      return true
    }
    catch (error) {
      status.value = 'error'
      errorMessage.value = extractIconError(error)
      return false
    }
  }

  async function upload(blob: Blob, filename: string): Promise<boolean> {
    if (uploadStatus.value !== 'idle') return false
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
      newestMediaId.value = response.icon.mediaId

      const refreshed = await load()
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
      errorMessage.value = extractIconError(error)
      announcement.value = 'Icon upload failed.'
      return false
    }
    finally {
      if (uploadStatus.value === 'uploading') uploadStatus.value = 'idle'
    }
  }

  function resetSessionMessage() {
    errorMessage.value = ''
    announcement.value = ''
    newestMediaId.value = null
    if (uploadStatus.value !== 'uploading') uploadStatus.value = 'idle'
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
  }
}
