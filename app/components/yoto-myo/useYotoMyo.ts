import type { YotoAuthStatus, YotoContentMineResponse, YotoMyoCard, YotoMyoStatus } from './types'
import { shouldPreserveAuxiliaryRefreshState } from '#shared/yoto/refreshPolicy'
import { removeDeletedCard } from '#shared/yoto/cardDeletion'

interface RefreshOptions {
  auxiliary?: boolean
}

function extractErrorMessage(err: unknown): string {
  const fetchErr = err as {
    statusCode?: number
    statusMessage?: string
    data?: { statusMessage?: string }
    message?: string
  }

  return fetchErr.data?.statusMessage
    ?? fetchErr.statusMessage
    ?? fetchErr.message
    ?? 'Failed to load Yoto content'
}

export function useYotoMyo() {
  const cards = ref<YotoMyoCard[]>([])
  const status = ref<YotoMyoStatus>('loading')
  const errorMessage = ref('')
  const configured = ref(false)
  const connected = ref(false)
  const hasWriteScope = ref(false)

  async function fetchCards(options: RefreshOptions = {}) {
    const previousCards = cards.value
    const wasConnected = connected.value
    status.value = 'loading'
    errorMessage.value = ''

    try {
      const data = await $fetch<YotoContentMineResponse>('/api/yoto/content/mine')
      cards.value = data.cards
      status.value = 'idle'
    }
    catch (err: unknown) {
      const fetchErr = err as { statusCode?: number }
      errorMessage.value = extractErrorMessage(err)

      if (
        shouldPreserveAuxiliaryRefreshState(
          options.auxiliary === true,
          wasConnected,
          fetchErr.statusCode,
        )
      ) {
        cards.value = previousCards
        status.value = 'idle'
        return
      }

      if (fetchErr.statusCode === 401) {
        connected.value = false
        status.value = 'disconnected'
        cards.value = []
        return
      }

      status.value = 'error'
      cards.value = []
    }
  }

  async function checkStatus(options: RefreshOptions = {}) {
    const previousCards = cards.value
    const wasConnected = connected.value
    status.value = 'loading'
    errorMessage.value = ''

    try {
      const data = await $fetch<YotoAuthStatus>('/api/yoto/auth/status')
      configured.value = data.configured
      connected.value = data.connected
      hasWriteScope.value = data.hasWriteScope ?? false

      if (!data.configured) {
        status.value = 'unconfigured'
        errorMessage.value = 'Yoto API not configured. Set NUXT_YOTO_CLIENT_ID in .env'
        return
      }

      if (!data.connected) {
        status.value = 'disconnected'
        cards.value = []
        return
      }

      await fetchCards(options)
    }
    catch (err: unknown) {
      const fetchErr = err as { statusCode?: number }
      errorMessage.value = extractErrorMessage(err)

      if (
        shouldPreserveAuxiliaryRefreshState(
          options.auxiliary === true,
          wasConnected,
          fetchErr.statusCode,
        )
      ) {
        cards.value = previousCards
        status.value = 'idle'
        return
      }

      status.value = 'error'
    }
  }

  function connect() {
    window.location.href = '/api/yoto/auth/login'
  }

  async function disconnect() {
    try {
      await $fetch('/api/yoto/auth/logout', { method: 'POST' })
    }
    catch {
      // Best-effort logout
    }

    connected.value = false
    hasWriteScope.value = false
    cards.value = []
    status.value = 'disconnected'
    errorMessage.value = ''
  }

  async function refresh() {
    await checkStatus()
  }

  async function refreshAfterContentMutation() {
    await checkStatus({ auxiliary: true })
  }

  async function removeCardAndRefresh(cardId: string) {
    cards.value = removeDeletedCard(cards.value, cardId)
    await checkStatus({ auxiliary: true })
  }

  onMounted(() => {
    checkStatus()
  })

  return {
    cards,
    status,
    errorMessage,
    configured,
    connected,
    hasWriteScope,
    connect,
    disconnect,
    refresh,
    refreshAfterContentMutation,
    removeCardAndRefresh,
    fetchCards,
  }
}
