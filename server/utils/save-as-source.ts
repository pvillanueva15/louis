import type {
  SaveAsSourceReference,
  SaveAsSourceSnapshot,
  YotoCardMetadata,
} from '../../shared/myo-editor/types.ts'
import {
  applyCardMutations,
  type CardMutation,
} from '../../shared/yoto/cardMutation.ts'
import {
  deriveRawCardRevision,
  type RawYotoCard,
} from './yoto-card-raw-contract.ts'

type RawRecord = Record<string, unknown>

export interface SaveAsSourceDependencies {
  fetchCard: (cardId: string, accessToken: string) => Promise<RawYotoCard>
}

const defaultDependencies: SaveAsSourceDependencies = {
  async fetchCard(cardId, accessToken) {
    const { fetchRawYotoCard } = await import('./yoto-card-raw.ts')
    return fetchRawYotoCard(cardId, accessToken)
  },
}

function isRecord(value: unknown): value is RawRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function toSaveAsSourceSnapshot(rawCard: RawYotoCard): SaveAsSourceSnapshot {
  if (typeof rawCard.title !== 'string' || !isRecord(rawCard.content)) {
    throw new Error('Yoto returned malformed card content.')
  }
  if (rawCard.metadata !== undefined && !isRecord(rawCard.metadata)) {
    throw new Error('Yoto returned malformed card metadata.')
  }
  const metadata = rawCard.metadata as YotoCardMetadata | undefined
  if (typeof metadata?.feedUrl === 'string' && metadata.feedUrl.trim()) {
    throw new Error('Podcast cards cannot be duplicated yet.')
  }
  return {
    title: rawCard.title,
    content: rawCard.content,
    ...(metadata ? { metadata } : {}),
  }
}

export async function resolveAuthoritativeSaveAsSource(
  reference: SaveAsSourceReference,
  mutations: CardMutation[],
  accessToken: string,
  dependencies: SaveAsSourceDependencies = defaultDependencies,
): Promise<SaveAsSourceSnapshot> {
  const rawCard = await dependencies.fetchCard(reference.cardId, accessToken)
  if (rawCard.cardId !== reference.cardId) {
    throw new Error('Yoto returned the wrong source card identity.')
  }
  if (deriveRawCardRevision(rawCard) !== reference.expectedRevision) {
    throw new Error('The source card changed after Save As was prepared. Reload it and try again.')
  }
  const materialized = mutations.length > 0
    ? applyCardMutations(rawCard, mutations)
    : rawCard
  return toSaveAsSourceSnapshot(materialized)
}
