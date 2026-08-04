export const COMMUNITY_ICON_MAX_RESULTS = 25
export const COMMUNITY_ICON_MAX_PAGE = 1_000
export const COMMUNITY_ICON_MAX_QUERY_LENGTH = 80
export const COMMUNITY_ICON_SEARCH_ORIGIN = 'https://www.yotoicons.com'
export const COMMUNITY_ICON_UPLOAD_OUTCOME_UNCERTAIN = 'community-icon-upload-outcome-uncertain'
export type CommunityIconUploadOutcomeUncertainCode = typeof COMMUNITY_ICON_UPLOAD_OUTCOME_UNCERTAIN

export interface CommunityIcon {
  id: string
  page: number
  title: string
  tags: string[]
  creator: string
  downloads: number | null
  previewUrl: string
  sourceUrl: string
}

export interface CommunityIconSearchResponse {
  query: string
  page: number
  nextPage: number | null
  icons: CommunityIcon[]
}

export function normalizeCommunityIconQuery(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Search text is required.')
  const query = value.trim().replace(/\s+/g, ' ')
  if (query.length < 1 || query.length > COMMUNITY_ICON_MAX_QUERY_LENGTH) {
    throw new Error('Search text must be between 1 and 80 characters.')
  }
  if (/\p{Cc}/u.test(query)) throw new Error('Search text contains unsupported characters.')
  return query
}

export function normalizeCommunityIconId(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9]\d{0,9}$/.test(value)) {
    throw new Error('Icon ID must be a canonical numeric ID.')
  }
  return value
}

export function normalizeCommunityIconPage(value: unknown): number {
  if (value === undefined) return 1
  const page = typeof value === 'string' && /^[1-9]\d*$/.test(value)
    ? Number(value)
    : value
  if (!Number.isInteger(page) || Number(page) < 1 || Number(page) > COMMUNITY_ICON_MAX_PAGE) {
    throw new Error(`Page must be an integer between 1 and ${COMMUNITY_ICON_MAX_PAGE}.`)
  }
  return Number(page)
}

export function buildCommunityIconSearchUrl(value: unknown, pageValue: unknown = 1): string {
  const query = normalizeCommunityIconQuery(value)
  const page = normalizeCommunityIconPage(pageValue)
  const params = new URLSearchParams({
    tag: query,
    sort: 'popular',
    type: 'singles',
    page: String(page),
  })
  return `${COMMUNITY_ICON_SEARCH_ORIGIN}/icons?${params.toString()}`
}

export function buildCommunityIconAssetUrl(value: unknown): string {
  const id = normalizeCommunityIconId(value)
  return `${COMMUNITY_ICON_SEARCH_ORIGIN}/static/uploads/${id}.png`
}
