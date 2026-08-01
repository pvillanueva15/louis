import { fetchYotoApi } from './yoto'
import {
  unwrapRawYotoCard,
  type RawYotoCard,
} from './yoto-card-raw-contract'

export async function fetchRawYotoCard(
  cardId: string,
  accessToken: string,
): Promise<RawYotoCard> {
  const raw = await fetchYotoApi<unknown>(`/content/${cardId}`, accessToken)
  try {
    return unwrapRawYotoCard(raw)
  }
  catch {
    throw createError({ statusCode: 502, statusMessage: 'Yoto returned a malformed card.' })
  }
}

export async function postRawYotoCard(
  accessToken: string,
  rawCard: RawYotoCard,
): Promise<unknown> {
  return fetchYotoApi('/content', accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: rawCard,
  })
}
