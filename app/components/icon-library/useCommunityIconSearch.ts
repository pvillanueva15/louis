import type { PersonalIconUploadResponse } from '#shared/yoto/iconContract'
import type {
  CommunityIcon,
  CommunityIconSearchResponse,
  CommunityIconUploadOutcomeUncertainCode,
} from '#shared/yoto/communityIconContract'
import { useIconLibrary } from './useIconLibrary.ts'

const COMMUNITY_ICON_UPLOAD_OUTCOME_UNCERTAIN: CommunityIconUploadOutcomeUncertainCode
  = 'community-icon-upload-outcome-uncertain'

type CommunitySearchStatus = 'idle' | 'searching' | 'ready' | 'error'

function extractCommunityError(error: unknown): string {
  const fetchError = error as {
    data?: { statusMessage?: string, message?: string }
    statusMessage?: string
    message?: string
  }
  return fetchError.data?.statusMessage
    ?? fetchError.data?.message
    ?? fetchError.statusMessage
    ?? fetchError.message
    ?? 'Community icon request failed.'
}

function extractCommunityErrorCode(error: unknown): string | undefined {
  const fetchError = error as {
    data?: { code?: string, data?: { code?: string } }
  }
  return fetchError.data?.data?.code ?? fetchError.data?.code
}

export function useCommunityIconSearch() {
  const query = ref('')
  const submittedQuery = ref('')
  const icons = ref<CommunityIcon[]>([])
  const status = ref<CommunitySearchStatus>('idle')
  const errorMessage = ref('')
  const nextPage = ref<number | null>(null)
  const loadingMore = ref(false)
  const importingId = ref<string | null>(null)
  const uploadOutcomeUncertain = ref(false)
  const canSearch = computed(() => query.value.trim().replace(/\s+/g, ' ').length > 0)
  const { recoveryRequired, markCommunityUploadOutcomeUncertain } = useIconLibrary()
  let generation = 0

  async function search(): Promise<boolean> {
    const requestGeneration = ++generation
    loadingMore.value = false
    const requestedQuery = query.value.trim().replace(/\s+/g, ' ')
    if (!requestedQuery) {
      submittedQuery.value = ''
      status.value = 'error'
      errorMessage.value = 'Enter a tag or title to search Yotoicons.'
      icons.value = []
      nextPage.value = null
      return false
    }

    status.value = 'searching'
    errorMessage.value = ''
    try {
      const response = await $fetch<CommunityIconSearchResponse>('/api/yoto/icons/community/search', {
        query: { q: requestedQuery },
      })
      if (generation !== requestGeneration) return false
      submittedQuery.value = response.query
      icons.value = response.icons
      nextPage.value = response.nextPage
      status.value = 'ready'
      return true
    }
    catch (error) {
      if (generation !== requestGeneration) return false
      icons.value = []
      nextPage.value = null
      status.value = 'error'
      errorMessage.value = extractCommunityError(error)
      return false
    }
  }

  async function loadMore(): Promise<boolean> {
    if (
      status.value !== 'ready'
      || loadingMore.value
      || nextPage.value === null
      || !submittedQuery.value
    ) return false

    const requestGeneration = generation
    const requestedPage = nextPage.value
    loadingMore.value = true
    errorMessage.value = ''
    try {
      const response = await $fetch<CommunityIconSearchResponse>('/api/yoto/icons/community/search', {
        query: { q: submittedQuery.value, page: requestedPage },
      })
      if (generation !== requestGeneration) return false
      const seen = new Set(icons.value.map(icon => icon.id))
      icons.value.push(...response.icons.filter(icon => !seen.has(icon.id)))
      nextPage.value = response.nextPage
      return true
    }
    catch (error) {
      if (generation !== requestGeneration) return false
      errorMessage.value = extractCommunityError(error)
      return false
    }
    finally {
      if (generation === requestGeneration) loadingMore.value = false
    }
  }

  async function importIcon(icon: CommunityIcon): Promise<PersonalIconUploadResponse | null> {
    if (
      recoveryRequired.value
      || uploadOutcomeUncertain.value
      || importingId.value
      || status.value !== 'ready'
      || !submittedQuery.value
    ) return null
    const requestGeneration = generation
    importingId.value = icon.id
    errorMessage.value = ''
    try {
      const response = await $fetch<PersonalIconUploadResponse>(
        `/api/yoto/icons/community/${icon.id}/import`,
        { method: 'POST', body: { query: submittedQuery.value, page: icon.page } },
      )
      if (generation !== requestGeneration) return null
      return response
    }
    catch (error) {
      if (generation !== requestGeneration) return null
      errorMessage.value = extractCommunityError(error)
      if (extractCommunityErrorCode(error) === COMMUNITY_ICON_UPLOAD_OUTCOME_UNCERTAIN) {
        uploadOutcomeUncertain.value = true
        markCommunityUploadOutcomeUncertain(errorMessage.value)
      }
      return null
    }
    finally {
      if (generation === requestGeneration) importingId.value = null
    }
  }

  function reset(): void {
    generation += 1
    query.value = ''
    submittedQuery.value = ''
    icons.value = []
    nextPage.value = null
    loadingMore.value = false
    status.value = 'idle'
    errorMessage.value = ''
    importingId.value = null
  }

  return {
    query,
    submittedQuery,
    icons,
    status,
    errorMessage,
    nextPage,
    loadingMore,
    importingId,
    uploadOutcomeUncertain,
    canSearch,
    search,
    loadMore,
    importIcon,
    reset,
  }
}
