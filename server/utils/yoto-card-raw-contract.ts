import { createHash } from 'node:crypto'

export type RawYotoCard = Record<string, unknown>

function isRecord(value: unknown): value is RawYotoCard {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function unwrapRawYotoCard(value: unknown): RawYotoCard {
  if (!isRecord(value)) throw new Error('Yoto returned a malformed card.')
  if ('card' in value) {
    if (!isRecord(value.card)) throw new Error('Yoto returned a malformed card.')
    return value.card
  }
  return value
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value !== 'object') {
    const encoded = JSON.stringify(value)
    if (encoded === undefined) throw new Error('Yoto returned a malformed card.')
    return encoded
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`

  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`
}

export function deriveRawCardRevision(rawCard: RawYotoCard): string {
  const hash = createHash('sha256')
    .update(canonicalJson(rawCard))
    .digest('base64url')
  return `v1.${hash}`
}
