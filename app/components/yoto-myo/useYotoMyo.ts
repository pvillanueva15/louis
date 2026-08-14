import type { YotoAuthStatus, YotoContentMineResponse, YotoMyoCard, YotoMyoStatus } from './types'
import { shouldPreserveAuxiliaryRefreshState } from '#shared/yoto/refreshPolicy'
import { removeDeletedCard } from '#shared/yoto/cardDeletion'

interface RefreshOptions {
  auxiliary?: boolean
}

/**
 * Why the user last summoned the auth gate. 'save' means they tried to save
 * a playlist while unauthenticated, so the TV can say why it came back.
 */
export type AuthGateIntent = 'save' | null

/**
 * Session-scoped memory of "Just looking" — a reload should not slam the TV
 * back over a browsing user, but a fresh session still boots to the TV.
 */
const GATE_DISMISSED_KEY = 'yoto-cards:auth-gate-dismissed'

function readGateDismissed(): boolean {
  if (typeof sessionStorage === 'undefined') return false
  try {
    return sessionStorage.getItem(GATE_DISMISSED_KEY) === '1'
  }
  catch {
    return false
  }
}

function writeGateDismissed(dismissed: boolean): void {
  if (typeof sessionStorage === 'undefined') return
  try {
    if (dismissed) {
      sessionStorage.setItem(GATE_DISMISSED_KEY, '1')
    }
    else {
      sessionStorage.removeItem(GATE_DISMISSED_KEY)
    }
  }
  catch {
    // Best effort — the gate simply reappears on reload.
  }
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
  const gateDismissed = ref(false)
  const gateIntent = ref<AuthGateIntent>(null)

  /** "Just looking" — hide the auth gate for the rest of this tab session. */
  function dismissGate() {
    gateDismissed.value = true
    gateIntent.value = null
    writeGateDismissed(true)
  }

  /** Bring the auth gate back (Connect Yoto affordance, save intent). */
  function summonGate(intent: AuthGateIntent = null) {
    gateIntent.value = intent
    gateDismissed.value = false
    writeGateDismissed(false)
  }

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
    gateDismissed.value = readGateDismissed()
    checkStatus()
  })

  return {
    cards,
    status,
    errorMessage,
    configured,
    connected,
    hasWriteScope,
    gateDismissed,
    gateIntent,
    dismissGate,
    summonGate,
    connect,
    disconnect,
    refresh,
    refreshAfterContentMutation,
    removeCardAndRefresh,
    fetchCards,
  }
}
