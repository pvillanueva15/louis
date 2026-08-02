export const PERSONAL_ICON_MEDIA_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/

export interface PersonalIcon {
  mediaId: string
  displayIconId: string
  url: string | null
  createdAt: string | null
}

export interface PersonalIconListResponse {
  icons: PersonalIcon[]
}

export interface PersonalIconUploadResponse {
  icon: PersonalIcon
  disposition: 'created' | 'existing'
}

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Yoto returned an invalid ${field}.`)
  }
  return value
}

function normalizeHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null

  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.toString() : null
  }
  catch {
    return null
  }
}

function normalizeCreatedAt(value: unknown): string | null {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null
  return value
}

export function normalizePersonalIcon(value: unknown): PersonalIcon {
  if (!isRecord(value)) throw new Error('Yoto returned an invalid personal icon.')

  const mediaId = requireNonEmptyString(value.mediaId, 'mediaId')
  if (!PERSONAL_ICON_MEDIA_ID_PATTERN.test(mediaId)) {
    throw new Error('Yoto returned an invalid mediaId.')
  }

  const displayIconId = requireNonEmptyString(
    value.displayIconId ?? value._id,
    'displayIconId',
  )

  return {
    mediaId,
    displayIconId,
    url: normalizeHttpsUrl(value.url),
    createdAt: normalizeCreatedAt(value.createdAt),
  }
}

export function normalizePersonalIconList(value: unknown): PersonalIconListResponse {
  if (!isRecord(value) || !Array.isArray(value.displayIcons)) {
    throw new Error('Yoto returned a malformed personal icon library.')
  }

  const icons = value.displayIcons.map((icon, index) => ({
    icon: normalizePersonalIcon(icon),
    index,
  }))

  icons.sort((a, b) => {
    if (a.icon.createdAt === null && b.icon.createdAt === null) return a.index - b.index
    if (a.icon.createdAt === null) return 1
    if (b.icon.createdAt === null) return -1

    const difference = Date.parse(b.icon.createdAt) - Date.parse(a.icon.createdAt)
    return difference === 0 ? a.index - b.index : difference
  })

  const seenMediaIds = new Set<string>()
  return {
    icons: icons
      .filter(({ icon }) => {
        if (seenMediaIds.has(icon.mediaId)) return false
        seenMediaIds.add(icon.mediaId)
        return true
      })
      .map(({ icon }) => icon),
  }
}

export function normalizePersonalIconUpload(value: unknown): PersonalIconUploadResponse {
  if (!isRecord(value) || !isRecord(value.displayIcon)) {
    throw new Error('Yoto returned a malformed icon upload response.')
  }

  return {
    icon: normalizePersonalIcon(value.displayIcon),
    disposition: value.displayIcon.new === true ? 'created' : 'existing',
  }
}
