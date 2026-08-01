import {
  applyRenameCardMutation,
  CardMutationError,
  type MutateCardRequest,
} from '../../shared/yoto/cardMutation.ts'
import {
  deriveRawCardRevision,
  type RawYotoCard,
} from './yoto-card-raw-contract.ts'

export interface CardMutationDependencies {
  fetchCard: (cardId: string, accessToken: string) => Promise<RawYotoCard>
  postCard: (accessToken: string, rawCard: RawYotoCard) => Promise<unknown>
}

const defaultDependencies: CardMutationDependencies = {
  async fetchCard(cardId, accessToken) {
    const { fetchRawYotoCard } = await import('./yoto-card-raw')
    return fetchRawYotoCard(cardId, accessToken)
  },
  async postCard(accessToken, rawCard) {
    const { postRawYotoCard } = await import('./yoto-card-raw')
    return postRawYotoCard(accessToken, rawCard)
  },
}

export async function mutateYotoCard(
  cardId: string,
  request: MutateCardRequest,
  accessToken: string,
  dependencies: CardMutationDependencies = defaultDependencies,
): Promise<{ cardId: string; title: string }> {
  const rawCard = await dependencies.fetchCard(cardId, accessToken)
  if (rawCard.cardId !== cardId) {
    throw new CardMutationError('invalid', 'Yoto returned the wrong card identity.')
  }
  if (deriveRawCardRevision(rawCard) !== request.expectedRevision) {
    throw new CardMutationError('conflict', 'The card changed after it was loaded.')
  }

  const renamed = applyRenameCardMutation(rawCard, request.mutations[0])
  await dependencies.postCard(accessToken, renamed)

  return { cardId, title: request.mutations[0].title }
}
