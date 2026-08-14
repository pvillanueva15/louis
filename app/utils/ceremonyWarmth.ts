const STORAGE_KEY = 'yoto-cards:ceremony-warmth'

export const CEREMONY_WARM_HOLD_MS = 400

function readWarmedCeremonies(): string[] {
  if (typeof sessionStorage === 'undefined') return []
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter(entry => typeof entry === 'string') : []
  }
  catch {
    return []
  }
}

function markCeremonyWarmed(ceremony: string) {
  if (typeof sessionStorage === 'undefined') return
  try {
    const warmed = readWarmedCeremonies()
    if (warmed.includes(ceremony)) return
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...warmed, ceremony]))
  }
  catch {
    // Storage unavailable: the ceremony simply stays cold.
  }
}

/**
 * Minimum hold for a loading ceremony: the full delay the first time a
 * ceremony runs in a tab session, a short floor on every run after that.
 * Warmth survives reloads (like `louis.splash.seen`) but not a new tab.
 */
export function ceremonyHoldMs(ceremony: string, coldMs: number, warmMs = CEREMONY_WARM_HOLD_MS): number {
  if (readWarmedCeremonies().includes(ceremony)) {
    return Math.min(warmMs, coldMs)
  }
  markCeremonyWarmed(ceremony)
  return coldMs
}
