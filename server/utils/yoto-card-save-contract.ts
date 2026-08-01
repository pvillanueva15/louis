import { createError } from 'h3'
import {
  getCardTitleValidationError,
  normalizeCardTitle,
} from '../../shared/yoto/cardMutation.ts'

export function requireValidUpdateCardTitle(value: unknown): string {
  const title = typeof value === 'string' ? normalizeCardTitle(value) : ''
  const validationError = getCardTitleValidationError(title)
  if (validationError) {
    throw createError({ statusCode: 400, statusMessage: validationError })
  }
  return title
}
