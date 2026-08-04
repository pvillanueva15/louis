import type { PersonalIconUploadResponse } from '../../shared/yoto/iconContract.ts'
import { STATIC_ICON_MAX_BYTES } from '../../shared/yoto/staticIcon.ts'
import {
  buildCommunityIconAssetUrl,
  buildCommunityIconSearchUrl,
  COMMUNITY_ICON_MAX_PAGE,
  COMMUNITY_ICON_MAX_RESULTS,
  COMMUNITY_ICON_UPLOAD_OUTCOME_UNCERTAIN,
  normalizeCommunityIconId,
  normalizeCommunityIconPage,
  normalizeCommunityIconQuery,
  type CommunityIcon,
  type CommunityIconSearchResponse,
} from '../../shared/yoto/communityIconContract.ts'
import {
  uploadPersonalIcon,
  validateCommunityIconPng,
  type YotoIconRequest,
} from './yoto-icons.ts'

export const COMMUNITY_ICON_HTML_MAX_BYTES = 512 * 1024
export const COMMUNITY_ICON_TIMEOUT_MS = 5_000
export const COMMUNITY_ICON_PUBLIC_THROTTLE_LIMIT = 300
export const COMMUNITY_ICON_IMPORT_THROTTLE_LIMIT = 30

interface CommunityFetchResponse {
  status: number
  url?: string
  redirected?: boolean
  headers: { get(name: string): string | null }
  body: ReadableStream<Uint8Array> | null
}

type CommunityFetch = (
  url: string,
  options: { redirect: 'manual', signal: AbortSignal },
) => Promise<CommunityFetchResponse>

interface CommunityIconServiceOptions {
  fetch?: CommunityFetch
  now?: () => number
  cacheTtlMs?: number
  maxCacheEntries?: number
  publicThrottleLimit?: number
  importThrottleLimit?: number
  throttleWindowMs?: number
  timeoutMs?: number
}

interface CacheEntry {
  expiresAt: number
  value: CommunityIconSearchResponse
}

type CommunityThrottleBucket = 'public' | 'import'

export class CommunityIconError extends Error {
  readonly statusCode: 400 | 404 | 413 | 415 | 429 | 502 | 504

  constructor(
    message: string,
    statusCode: CommunityIconError['statusCode'],
  ) {
    super(message)
    this.statusCode = statusCode
  }
}

export class CommunityIconUploadOutcomeUncertainError extends Error {
  readonly code = COMMUNITY_ICON_UPLOAD_OUTCOME_UNCERTAIN
  readonly statusCode = 502

  constructor() {
    super('The Yoto upload may have succeeded. Do not retry blindly; close and reopen the icon library to refresh My Icons before trying again.')
  }
}

function isDefiniteYotoUploadRejection(error: unknown): boolean {
  const statusCode = (error as { statusCode?: number }).statusCode
  return typeof statusCode === 'number'
    && statusCode >= 400
    && statusCode < 500
    && statusCode !== 408
    && statusCode !== 429
}

function decodeHtml(value: string): string {
  return value.replace(/&(#\d+|#x[\da-f]+|amp|quot|apos|lt|gt|#39);/gi, (entity, code: string) => {
    if (code === 'amp') return '&'
    if (code === 'quot') return '"'
    if (code === 'apos' || code === '#39') return "'"
    if (code === 'lt') return '<'
    if (code === 'gt') return '>'
    const point = code.toLowerCase().startsWith('#x')
      ? Number.parseInt(code.slice(2), 16)
      : Number.parseInt(code.slice(1), 10)
    return Number.isInteger(point) && point > 0 && point <= 0x10ffff
      ? String.fromCodePoint(point)
      : entity
  })
}

function parseJsString(value: string): string {
  const unescaped = value.replace(/\\(['\\])/g, '$1')
  if (unescaped.includes('\\')) throw new CommunityIconError('Yotoicons markup contains an unsupported escape.', 502)
  return decodeHtml(unescaped).trim()
}

function requireMetadata(value: string, field: string): string {
  if (!value || value.length > 200 || /\p{Cc}/u.test(value)) {
    throw new CommunityIconError(`Yotoicons returned an invalid ${field}.`, 502)
  }
  return value
}

function normalizeCommunityQuery(value: unknown): string {
  try {
    return normalizeCommunityIconQuery(value)
  }
  catch (error) {
    throw new CommunityIconError(error instanceof Error ? error.message : 'Invalid search text.', 400)
  }
}

function normalizeCommunityPage(value: unknown): number {
  try {
    return normalizeCommunityIconPage(value)
  }
  catch (error) {
    throw new CommunityIconError(error instanceof Error ? error.message : 'Invalid page.', 400)
  }
}

export function parseCommunityIconSearchHtml(
  html: string,
  query: string,
  pageValue: unknown = 1,
): CommunityIconSearchResponse {
  const normalizedQuery = normalizeCommunityQuery(query)
  const page = normalizeCommunityPage(pageValue)
  const sourceUrl = buildCommunityIconSearchUrl(normalizedQuery, page)
  const section = html.match(/<section\s+id=["']search_results["']>([\s\S]*?)<\/section>/i)?.[1]
  if (section === undefined) {
    throw new CommunityIconError('Yotoicons search markup changed.', 502)
  }

  const rawTotal = html.match(/<section\s+id=["']search_info["']>[\s\S]*?<p>\s*We(?:'|&#39;)ve got ([\d,]+) icons with that tag:\s*<\/p>[\s\S]*?<\/section>/i)?.[1]
  const total = rawTotal === undefined ? NaN : Number(rawTotal.replaceAll(',', ''))
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new CommunityIconError('Yotoicons search markup changed.', 502)
  }

  const cardStarts = section.match(/<div\s+class=["']icon["']\s+onclick=["']populate_icon_modal\(/g) ?? []
  const cardPattern = /<div\s+class="icon"\s+onclick="populate_icon_modal\('((?:[^'\\]|\\.)*)',\s*'((?:[^'\\]|\\.)*)',\s*'((?:[^'\\]|\\.)*)',\s*'((?:[^'\\]|\\.)*)',\s*'((?:[^'\\]|\\.)*)',\s*'((?:[^'\\]|\\.)*)'\);">\s*<div\s+class="icon_background">\s*<img\s+src="\/static\/uploads\/([^"]+)\.png"\s*>\s*<\/div>\s*<div\s+class="artist">@([^<]+)<\/div>\s*<\/div>/g
  const icons: CommunityIcon[] = []
  const seen = new Set<string>()

  for (const match of section.matchAll(cardPattern)) {
    let id: string
    try {
      id = normalizeCommunityIconId(match[1])
    }
    catch {
      throw new CommunityIconError('Yotoicons returned a non-canonical icon ID.', 502)
    }
    if (seen.has(id)) throw new CommunityIconError('Yotoicons returned a duplicate icon ID.', 502)
    if (match[7] !== id) throw new CommunityIconError('Yotoicons returned a mismatched icon asset.', 502)

    const category = requireMetadata(parseJsString(match[2]!), 'category')
    const title = requireMetadata(parseJsString(match[3]!), 'title')
    const secondaryTag = parseJsString(match[4]!)
    const creator = requireMetadata(parseJsString(match[5]!), 'creator')
    if (decodeHtml(match[8]!).trim() !== creator) {
      throw new CommunityIconError('Yotoicons returned mismatched creator metadata.', 502)
    }

    const rawDownloads = parseJsString(match[6]!)
    if (rawDownloads && !/^\d+$/.test(rawDownloads)) {
      throw new CommunityIconError('Yotoicons returned an invalid download count.', 502)
    }
    const downloads = rawDownloads ? Number(rawDownloads) : null
    if (downloads !== null && !Number.isSafeInteger(downloads)) {
      throw new CommunityIconError('Yotoicons returned an invalid download count.', 502)
    }

    const tags = [category, secondaryTag]
      .filter((tag): tag is string => Boolean(tag))
      .filter((tag, index, values) => values.indexOf(tag) === index)
    seen.add(id)
    icons.push({
      id,
      page,
      title,
      tags,
      creator,
      downloads,
      previewUrl: `/api/yoto/icons/community/${id}/preview`,
      sourceUrl,
    })
  }

  const expectedCount = Math.min(
    COMMUNITY_ICON_MAX_RESULTS,
    Math.max(0, total - ((page - 1) * COMMUNITY_ICON_MAX_RESULTS)),
  )
  if (
    cardStarts.length !== icons.length
    || icons.length !== expectedCount
    || icons.length > COMMUNITY_ICON_MAX_RESULTS
  ) {
    throw new CommunityIconError('Yotoicons search markup changed or exceeded 25 results.', 502)
  }

  return {
    query: normalizedQuery,
    page,
    nextPage: page < COMMUNITY_ICON_MAX_PAGE && page * COMMUNITY_ICON_MAX_RESULTS < total
      ? page + 1
      : null,
    icons,
  }
}

async function readBoundedResponse(
  response: CommunityFetchResponse,
  maximumBytes: number,
): Promise<Uint8Array> {
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new CommunityIconError('Yotoicons response exceeded the allowed size.', 413)
  }
  if (!response.body) throw new CommunityIconError('Yotoicons returned an empty response.', 502)

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      if (length + result.value.byteLength > maximumBytes) {
        await reader.cancel()
        throw new CommunityIconError('Yotoicons response exceeded the allowed size.', 413)
      }
      length += result.value.byteLength
      chunks.push(result.value)
    }
  }
  finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

export class CommunityIconService {
  private readonly fetch: CommunityFetch
  private readonly now: () => number
  private readonly cacheTtlMs: number
  private readonly maxCacheEntries: number
  private readonly publicThrottleLimit: number
  private readonly importThrottleLimit: number
  private readonly throttleWindowMs: number
  private readonly timeoutMs: number
  private readonly cache = new Map<string, CacheEntry>()
  private readonly inFlight = new Map<string, Promise<CommunityIconSearchResponse>>()
  private publicRequestTimes: number[] = []
  private importRequestTimes: number[] = []

  constructor(options: CommunityIconServiceOptions = {}) {
    this.fetch = options.fetch ?? (globalThis.fetch as CommunityFetch)
    this.now = options.now ?? Date.now
    this.cacheTtlMs = options.cacheTtlMs ?? 30_000
    this.maxCacheEntries = options.maxCacheEntries ?? 20
    this.publicThrottleLimit = options.publicThrottleLimit ?? COMMUNITY_ICON_PUBLIC_THROTTLE_LIMIT
    this.importThrottleLimit = options.importThrottleLimit ?? COMMUNITY_ICON_IMPORT_THROTTLE_LIMIT
    this.throttleWindowMs = options.throttleWindowMs ?? 60_000
    this.timeoutMs = options.timeoutMs ?? COMMUNITY_ICON_TIMEOUT_MS
  }

  private consumeThrottle(bucket: CommunityThrottleBucket): void {
    const now = this.now()
    const requestTimes = (bucket === 'public' ? this.publicRequestTimes : this.importRequestTimes)
      .filter(time => now - time < this.throttleWindowMs)
    const limit = bucket === 'public' ? this.publicThrottleLimit : this.importThrottleLimit
    if (requestTimes.length >= limit) {
      throw new CommunityIconError('Community icon requests are temporarily limited. Try again shortly.', 429)
    }
    requestTimes.push(now)
    if (bucket === 'public') this.publicRequestTimes = requestTimes
    else this.importRequestTimes = requestTimes
  }

  private async request(
    url: string,
    maximumBytes: number,
    expectedType: string,
    deadline: number,
    signal?: AbortSignal,
    bucket: CommunityThrottleBucket = 'public',
  ): Promise<Uint8Array> {
    const remaining = deadline - this.now()
    if (remaining <= 0) throw new CommunityIconError('Yotoicons request timed out.', 504)
    this.consumeThrottle(bucket)

    const controller = signal ? null : new AbortController()
    const requestSignal = signal ?? controller!.signal
    const timer = controller ? setTimeout(() => controller.abort(), remaining) : null
    try {
      if (requestSignal.aborted) throw new CommunityIconError('Yotoicons request timed out.', 504)
      const response = await this.fetch(url, { redirect: 'manual', signal: requestSignal })
      if (response.status >= 300 && response.status < 400) {
        throw new CommunityIconError('Yotoicons redirects are not allowed.', 502)
      }
      if (response.status === 403 || response.status === 429) {
        throw new CommunityIconError(`Yotoicons rejected the request (${response.status}).`, 502)
      }
      if (response.status !== 200) throw new CommunityIconError(`Yotoicons returned HTTP ${response.status}.`, 502)
      if (response.redirected || (response.url && response.url !== url)) {
        throw new CommunityIconError('Yotoicons returned an unexpected response URL.', 502)
      }
      const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (contentType !== expectedType) {
        throw new CommunityIconError(`Yotoicons returned unsupported ${expectedType} content.`, 415)
      }
      return await readBoundedResponse(response, maximumBytes)
    }
    catch (error) {
      if (requestSignal.aborted) throw new CommunityIconError('Yotoicons request timed out.', 504)
      if (error instanceof CommunityIconError) throw error
      throw new CommunityIconError('Yotoicons could not be reached or returned a malformed response.', 502)
    }
    finally {
      if (timer) clearTimeout(timer)
    }
  }

  private async fetchSearch(
    query: string,
    page: number,
    deadline: number,
    signal?: AbortSignal,
    bucket: CommunityThrottleBucket = 'public',
  ): Promise<CommunityIconSearchResponse> {
    const url = buildCommunityIconSearchUrl(query, page)
    const bytes = await this.request(url, COMMUNITY_ICON_HTML_MAX_BYTES, 'text/html', deadline, signal, bucket)
    try {
      return parseCommunityIconSearchHtml(new TextDecoder('utf-8', { fatal: true }).decode(bytes), query, page)
    }
    catch (error) {
      if (error instanceof CommunityIconError) throw error
      throw new CommunityIconError('Yotoicons returned malformed UTF-8 HTML.', 502)
    }
  }

  async search(
    value: unknown,
    options: { page?: unknown, fresh?: boolean, deadline?: number, signal?: AbortSignal } = {},
  ): Promise<CommunityIconSearchResponse> {
    const query = normalizeCommunityQuery(value)
    const page = normalizeCommunityPage(options.page)
    const url = buildCommunityIconSearchUrl(query, page)
    const now = this.now()
    if (!options.fresh) {
      const cached = this.cache.get(url)
      if (cached && cached.expiresAt > now) return cached.value
      if (cached) this.cache.delete(url)
    }

    const deadline = options.deadline ?? now + this.timeoutMs
    const store = (value: CommunityIconSearchResponse) => {
      this.cache.delete(url)
      this.cache.set(url, { expiresAt: this.now() + this.cacheTtlMs, value })
      while (this.cache.size > this.maxCacheEntries) {
        const oldest = this.cache.keys().next().value
        if (oldest === undefined) break
        this.cache.delete(oldest)
      }
      return value
    }
    if (options.fresh) {
      return this.fetchSearch(query, page, deadline, options.signal, 'import').then(store)
    }

    const current = this.inFlight.get(url)
    if (current) return current
    const request = this.fetchSearch(query, page, deadline, options.signal)
      .then(store)
      .finally(() => this.inFlight.delete(url))
    this.inFlight.set(url, request)
    return request
  }

  async preview(
    value: unknown,
    deadline = this.now() + this.timeoutMs,
    signal?: AbortSignal,
    bucket: CommunityThrottleBucket = 'public',
  ): Promise<Uint8Array> {
    let id: string
    try {
      id = normalizeCommunityIconId(value)
    }
    catch (error) {
      throw new CommunityIconError(error instanceof Error ? error.message : 'Invalid icon ID.', 400)
    }
    const bytes = await this.request(
      buildCommunityIconAssetUrl(id),
      STATIC_ICON_MAX_BYTES,
      'image/png',
      deadline,
      signal,
      bucket,
    )
    try {
      validateCommunityIconPng(bytes)
    }
    catch (error) {
      throw new CommunityIconError(error instanceof Error ? error.message : 'Unsupported PNG.', 415)
    }
    return bytes
  }

  async importIcon(
    queryValue: unknown,
    idValue: unknown,
    pageValue: unknown,
    accessToken: string,
    yotoRequest: YotoIconRequest,
  ): Promise<PersonalIconUploadResponse> {
    let id: string
    try {
      id = normalizeCommunityIconId(idValue)
    }
    catch (error) {
      throw new CommunityIconError(error instanceof Error ? error.message : 'Invalid icon ID.', 400)
    }
    const query = normalizeCommunityQuery(queryValue)
    const page = normalizeCommunityPage(pageValue)
    const deadline = this.now() + this.timeoutMs
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let uploadStarted = false
    try {
      const metadata = await this.search(query, { page, fresh: true, deadline, signal: controller.signal })
      if (!metadata.icons.some(icon => icon.id === id)) {
        throw new CommunityIconError('The icon is no longer present in the current search results.', 404)
      }
      const bytes = await this.preview(id, deadline, controller.signal, 'import')
      if (controller.signal.aborted) throw new CommunityIconError('Yotoicons request timed out.', 504)
      uploadStarted = true
      return await uploadPersonalIcon(
        bytes,
        `yotoicons-${id}`,
        accessToken,
        yotoRequest,
        {
          signal: controller.signal,
          validator: validateCommunityIconPng,
        },
      )
    }
    catch (error) {
      if (uploadStarted) {
        if (isDefiniteYotoUploadRejection(error)) throw error
        throw new CommunityIconUploadOutcomeUncertainError()
      }
      if (controller.signal.aborted) throw new CommunityIconError('Yotoicons request timed out.', 504)
      throw error
    }
    finally {
      clearTimeout(timer)
    }
  }
}

export const communityIconService = new CommunityIconService()
