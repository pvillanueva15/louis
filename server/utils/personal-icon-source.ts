import {
  PERSONAL_ICON_MEDIA_ID_PATTERN,
  type PersonalIconListResponse,
} from '../../shared/yoto/iconContract.ts'
import { STATIC_ICON_MAX_BYTES } from '../../shared/yoto/staticIcon.ts'
import { validateStaticIconPng } from './yoto-icons.ts'

export const PERSONAL_ICON_SOURCE_ORIGIN = 'https://media-secure-v2.api.yotoplay.com'
export const PERSONAL_ICON_SOURCE_TIMEOUT_MS = 5_000

export type PersonalIconSourceErrorCode = 'unavailable' | 'unsupported' | 'temporary'

export class PersonalIconSourceError extends Error {
  readonly code: PersonalIconSourceErrorCode
  readonly statusCode: 400 | 404 | 415 | 502 | 504

  constructor(
    code: PersonalIconSourceErrorCode,
    statusCode: PersonalIconSourceError['statusCode'],
    message: string,
  ) {
    super(message)
    this.code = code
    this.statusCode = statusCode
  }
}

interface PersonalIconSourceResponse {
  status: number
  url?: string
  redirected?: boolean
  headers: { get(name: string): string | null }
  body: ReadableStream<Uint8Array> | null
}

type PersonalIconSourceFetch = (
  url: string,
  options: { redirect: 'manual', signal: AbortSignal },
) => Promise<PersonalIconSourceResponse>

interface PersonalIconSourceServiceOptions {
  fetch?: PersonalIconSourceFetch
  timeoutMs?: number
}

interface PersonalIconSourceIdentity {
  displayIconId: string
  mediaId: string
}

export interface PersonalIconSourceResult {
  bytes: Uint8Array
  filename: string
}

function normalizeIdentity(value: unknown): PersonalIconSourceIdentity {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PersonalIconSourceError('unavailable', 400, 'Invalid Personal Icon source identity.')
  }
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join(',') !== 'displayIconId,mediaId') {
    throw new PersonalIconSourceError('unavailable', 400, 'Invalid Personal Icon source identity.')
  }

  const rawDisplayIconId = typeof record.displayIconId === 'string' ? record.displayIconId : ''
  const displayIconId = rawDisplayIconId.trim()
  const mediaId = typeof record.mediaId === 'string' ? record.mediaId : ''
  if (
    displayIconId.length < 1
    || displayIconId.length > 128
    || displayIconId !== rawDisplayIconId
    || /\p{Cc}/u.test(displayIconId)
    || !PERSONAL_ICON_MEDIA_ID_PATTERN.test(mediaId)
  ) {
    throw new PersonalIconSourceError('unavailable', 400, 'Invalid Personal Icon source identity.')
  }

  return { displayIconId, mediaId }
}

function requireAcceptedUrl(value: string): void {
  let url: URL
  try {
    url = new URL(value)
  }
  catch {
    throw new PersonalIconSourceError('unsupported', 415, 'Unsupported Personal Icon source.')
  }
  if (
    url.protocol !== 'https:'
    || url.username !== ''
    || url.password !== ''
    || url.port !== ''
    || url.origin !== PERSONAL_ICON_SOURCE_ORIGIN
  ) {
    throw new PersonalIconSourceError('unsupported', 415, 'Unsupported Personal Icon source.')
  }
}

async function readBoundedPng(response: PersonalIconSourceResponse): Promise<Uint8Array> {
  const declaredLength = response.headers.get('content-length')
  let expectedLength: number | null = null
  if (declaredLength !== null) {
    expectedLength = Number(declaredLength)
    if (!Number.isSafeInteger(expectedLength) || expectedLength < 1 || expectedLength > STATIC_ICON_MAX_BYTES) {
      throw new PersonalIconSourceError('unsupported', 415, 'Unsupported Personal Icon source.')
    }
  }
  if (!response.body) {
    throw new PersonalIconSourceError('temporary', 502, 'Personal Icon source returned no body.')
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      if (length + result.value.byteLength > STATIC_ICON_MAX_BYTES) {
        await reader.cancel()
        throw new PersonalIconSourceError('unsupported', 415, 'Unsupported Personal Icon source.')
      }
      length += result.value.byteLength
      chunks.push(result.value)
    }
  }
  finally {
    reader.releaseLock()
  }
  if (length < 1 || (expectedLength !== null && length !== expectedLength)) {
    throw new PersonalIconSourceError('temporary', 502, 'Personal Icon source length did not match.')
  }

  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

export class PersonalIconSourceService {
  private readonly fetch: PersonalIconSourceFetch
  private readonly timeoutMs: number

  constructor(options: PersonalIconSourceServiceOptions = {}) {
    this.fetch = options.fetch ?? (globalThis.fetch as unknown as PersonalIconSourceFetch)
    this.timeoutMs = options.timeoutMs ?? PERSONAL_ICON_SOURCE_TIMEOUT_MS
  }

  async load(
    value: unknown,
    listPersonalIcons: () => Promise<PersonalIconListResponse>,
    requestSignal?: AbortSignal,
  ): Promise<PersonalIconSourceResult> {
    const identity = normalizeIdentity(value)
    const library = await listPersonalIcons()
    const matches = library.icons.filter(icon => (
      icon.displayIconId === identity.displayIconId && icon.mediaId === identity.mediaId
    ))
    if (matches.length !== 1 || !matches[0]!.url) {
      throw new PersonalIconSourceError('unavailable', 404, 'Personal Icon source is unavailable.')
    }

    requireAcceptedUrl(matches[0]!.url)
    const sourceUrl = matches[0]!.url
    const controller = new AbortController()
    const abortFromRequest = () => controller.abort()
    if (requestSignal?.aborted) controller.abort()
    else requestSignal?.addEventListener('abort', abortFromRequest, { once: true })
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.timeoutMs)
    try {
      const response = await this.fetch(sourceUrl, { redirect: 'manual', signal: controller.signal })

      if (response.redirected || response.url !== sourceUrl || (response.status >= 300 && response.status < 400)) {
        throw new PersonalIconSourceError('unsupported', 415, 'Unsupported Personal Icon source.')
      }
      if (response.status !== 200) {
        throw new PersonalIconSourceError('temporary', 502, 'Personal Icon source request failed.')
      }
      const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (contentType !== 'image/png') {
        throw new PersonalIconSourceError('unsupported', 415, 'Unsupported Personal Icon source.')
      }

      const bytes = await readBoundedPng(response)
      try {
        validateStaticIconPng(bytes)
      }
      catch {
        throw new PersonalIconSourceError('unsupported', 415, 'Unsupported Personal Icon source.')
      }

      return {
        bytes,
        filename: `personal-icon-${identity.mediaId.slice(0, 12)}.png`,
      }
    }
    catch (error) {
      if (error instanceof PersonalIconSourceError) throw error
      throw new PersonalIconSourceError(
        'temporary',
        timedOut ? 504 : 502,
        'Personal Icon source request failed.',
      )
    }
    finally {
      clearTimeout(timeout)
      requestSignal?.removeEventListener('abort', abortFromRequest)
    }
  }
}

export function createPersonalIconSourceService(
  options: PersonalIconSourceServiceOptions = {},
): PersonalIconSourceService {
  return new PersonalIconSourceService(options)
}

export const personalIconSourceService = createPersonalIconSourceService()
