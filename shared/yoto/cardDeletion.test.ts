import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  captureCardDeletionTarget,
  classifyCardDeletionFailure,
  isCardDeletionAvailable,
  isCardDeletionTargetCurrent,
  isExactCardTitleConfirmation,
  parseDeleteCardRequest,
  removeDeletedCard,
  restoreCardDeletionFocus,
  resolveCardDeletionTabTarget,
  runCardDeletionClientAttempt,
  tryRestoreCardDeletionFocus,
  UNCERTAIN_CARD_DELETION_MESSAGE,
  type CardDeletionClientHandlers,
  type CardDeletionAvailability,
  type CardDeletionFailure,
  type CardDeletionFocusTarget,
  type CardDeletionTarget,
} from './cardDeletion.ts'

const REVISION = `v1.${'a'.repeat(43)}`

function available(overrides: Partial<CardDeletionAvailability> = {}): CardDeletionAvailability {
  return {
    selectedCardId: 'card-1',
    isNewPlaylist: false,
    isPodcast: false,
    baselineTitle: ' Bedtime 🌙 ',
    revision: REVISION,
    isDirty: false,
    loading: false,
    saveJobActive: false,
    mutationActive: false,
    deletionActive: false,
    pollingOrHydrating: false,
    persistedSaveActive: false,
    outcomeUncertain: false,
    ...overrides,
  }
}

function clientHarness(target: CardDeletionTarget) {
  const state = {
    selectedCardId: target.cardId as string | null,
    cardTitle: target.baselineTitle,
    playlist: ['track-1'],
    cards: [
      { cardId: target.cardId, title: target.baselineTitle },
      { cardId: 'card-10', title: 'Keep me' },
    ],
    deletionOutcomeUncertain: false,
    errorMessage: '',
    cleanupCount: 0,
  }
  const handlers: CardDeletionClientHandlers = {
    onValidatedSuccess: (deletedTarget) => {
      state.cleanupCount += 1
      state.selectedCardId = null
      state.cardTitle = ''
      state.playlist = []
      state.cards = removeDeletedCard(state.cards, deletedTarget.cardId)
      state.deletionOutcomeUncertain = false
    },
    onFailure: (failure: CardDeletionFailure) => {
      state.deletionOutcomeUncertain = failure.outcomeUncertain
      state.errorMessage = failure.message
    },
  }
  return { state, handlers }
}

describe('card deletion contract', () => {
  it('parses an exact title without trimming, case folding, or Unicode normalization', () => {
    assert.deepEqual(parseDeleteCardRequest({
      expectedRevision: REVISION,
      expectedTitle: ' Bedtime 🌙 ',
    }), {
      expectedRevision: REVISION,
      expectedTitle: ' Bedtime 🌙 ',
    })
    assert.throws(() => parseDeleteCardRequest(null), /malformed/)
    assert.throws(() => parseDeleteCardRequest({ expectedRevision: 'v1.bad', expectedTitle: 'x' }), /expectedRevision/)
    assert.throws(() => parseDeleteCardRequest({ expectedRevision: REVISION }), /expectedTitle/)
    assert.throws(() => parseDeleteCardRequest({
      expectedRevision: REVISION,
      expectedTitle: 'x',
      retry: true,
    }), /malformed/)
  })

  it('requires every client availability gate', () => {
    assert.equal(isCardDeletionAvailable(available()), true)
    const blocked: Array<Partial<CardDeletionAvailability>> = [
      { selectedCardId: null },
      { isNewPlaylist: true },
      { isPodcast: true },
      { baselineTitle: '' },
      { revision: '' },
      { isDirty: true },
      { loading: true },
      { saveJobActive: true },
      { mutationActive: true },
      { deletionActive: true },
      { pollingOrHydrating: true },
      { persistedSaveActive: true },
      { outcomeUncertain: true },
    ]
    for (const override of blocked) {
      assert.equal(isCardDeletionAvailable(available(override)), false, JSON.stringify(override))
    }
  })

  it('captures an immutable target and invalidates every stale identity field', () => {
    const target = captureCardDeletionTarget(available())
    assert.deepEqual(target, {
      cardId: 'card-1',
      baselineTitle: ' Bedtime 🌙 ',
      revision: REVISION,
    })
    assert.equal(Object.isFrozen(target), true)
    assert.ok(target)
    assert.equal(isCardDeletionTargetCurrent(target, available()), true)
    assert.equal(isCardDeletionTargetCurrent(target, available({ selectedCardId: 'card-2' })), false)
    assert.equal(isCardDeletionTargetCurrent(target, available({ baselineTitle: 'Bedtime 🌙' })), false)
    assert.equal(isCardDeletionTargetCurrent(target, available({ revision: `v1.${'b'.repeat(43)}` })), false)
    assert.equal(isCardDeletionTargetCurrent(target, available({ loading: true })), false)
  })

  it('requires exact confirmation including whitespace, case, and Unicode code points', () => {
    const target = captureCardDeletionTarget(available())!
    assert.equal(isExactCardTitleConfirmation(' Bedtime 🌙 ', target), true)
    assert.equal(isExactCardTitleConfirmation('bedtime 🌙', target), false)
    assert.equal(isExactCardTitleConfirmation('Bedtime 🌙', target), false)
    assert.equal(isExactCardTitleConfirmation(' Bedtime 🌙  ', target), false)
    assert.equal(isExactCardTitleConfirmation(' Be\u0301dtime 🌙 ', target), false)
  })

  it('classifies known preflight failures as safe and ambiguous outcomes as uncertain', () => {
    for (const statusCode of [400, 401, 403, 404, 409]) {
      assert.deepEqual(classifyCardDeletionFailure({
        statusCode,
        data: { statusMessage: `safe-${statusCode}` },
      }), { message: `safe-${statusCode}`, outcomeUncertain: false })
    }
    for (const error of [
      new TypeError('network lost'),
      { statusCode: 408 },
      { statusCode: 429 },
      { statusCode: 500 },
      { statusCode: 502 },
    ]) {
      assert.deepEqual(classifyCardDeletionFailure(error), {
        message: UNCERTAIN_CARD_DELETION_MESSAGE,
        outcomeUncertain: true,
      })
    }
    assert.deepEqual(classifyCardDeletionFailure({
      statusCode: 502,
      data: { outcomeUncertain: false, statusMessage: 'Yoto returned a malformed card.' },
    }), {
      message: 'Yoto returned a malformed card.',
      outcomeUncertain: false,
    })
  })

  it('preserves editor and card state after a safe client deletion failure', async () => {
    const target = captureCardDeletionTarget(available())!
    const { state, handlers } = clientHarness(target)

    const deleted = await runCardDeletionClientAttempt(
      target,
      () => Promise.reject({ statusCode: 409, data: { statusMessage: 'Reload this card.' } }),
      handlers,
    )

    assert.equal(deleted, false)
    assert.equal(state.selectedCardId, 'card-1')
    assert.equal(state.cardTitle, ' Bedtime 🌙 ')
    assert.deepEqual(state.playlist, ['track-1'])
    assert.deepEqual(state.cards.map(card => card.cardId), ['card-1', 'card-10'])
    assert.equal(state.cleanupCount, 0)
    assert.equal(state.deletionOutcomeUncertain, false)
    assert.equal(state.errorMessage, 'Reload this card.')
  })

  it('preserves state and blocks retry after an uncertain client deletion failure', async () => {
    const target = captureCardDeletionTarget(available())!
    const { state, handlers } = clientHarness(target)

    const deleted = await runCardDeletionClientAttempt(
      target,
      () => Promise.reject(new TypeError('network lost')),
      handlers,
    )

    assert.equal(deleted, false)
    assert.equal(state.selectedCardId, 'card-1')
    assert.deepEqual(state.cards.map(card => card.cardId), ['card-1', 'card-10'])
    assert.equal(state.cleanupCount, 0)
    assert.equal(state.deletionOutcomeUncertain, true)
    assert.equal(state.errorMessage, UNCERTAIN_CARD_DELETION_MESSAGE)
    assert.equal(isCardDeletionAvailable(available({ outcomeUncertain: true })), false)
  })

  it('rejects malformed success responses without cleanup', async () => {
    const target = captureCardDeletionTarget(available())!
    for (const response of [
      null,
      { status: 'ok', cardId: 'card-10' },
      { status: 'deleted', cardId: target.cardId },
    ]) {
      const { state, handlers } = clientHarness(target)
      const deleted = await runCardDeletionClientAttempt(
        target,
        () => Promise.resolve(response),
        handlers,
      )

      assert.equal(deleted, false)
      assert.equal(state.selectedCardId, 'card-1')
      assert.deepEqual(state.cards.map(card => card.cardId), ['card-1', 'card-10'])
      assert.equal(state.cleanupCount, 0)
      assert.equal(state.deletionOutcomeUncertain, true)
    }
  })

  it('clears editor state and removes only the exact card after validated success', async () => {
    const target = captureCardDeletionTarget(available())!
    const { state, handlers } = clientHarness(target)

    const deleted = await runCardDeletionClientAttempt(
      target,
      () => Promise.resolve({ status: 'ok', cardId: target.cardId }),
      handlers,
    )

    assert.equal(deleted, true)
    assert.equal(state.selectedCardId, null)
    assert.equal(state.cardTitle, '')
    assert.deepEqual(state.playlist, [])
    assert.deepEqual(state.cards, [{ cardId: 'card-10', title: 'Keep me' }])
    assert.equal(state.cleanupCount, 1)
    assert.equal(state.deletionOutcomeUncertain, false)
    assert.equal(state.errorMessage, '')
  })

  it('keeps the busy deletion dialog as the tab target when controls are disabled', () => {
    const dialog = { name: 'dialog' }
    const first = { name: 'first' }
    const last = { name: 'last' }

    assert.equal(resolveCardDeletionTabTarget(dialog, [], null, false), dialog)
    assert.equal(resolveCardDeletionTabTarget(dialog, [first, last], first, true), last)
    assert.equal(resolveCardDeletionTabTarget(dialog, [first, last], last, false), first)
    assert.equal(resolveCardDeletionTabTarget(dialog, [first, last], {}, false), first)
    assert.equal(resolveCardDeletionTabTarget(dialog, [first, last], first, false), null)
  })

  it('restores focus only to a connected usable target that actually receives it', () => {
    let activeElement: unknown = null
    let focusCalls = 0
    function target(overrides: {
      connected?: boolean
      tabIndex?: number
      disabled?: boolean
      receivesFocus?: boolean
    } = {}): CardDeletionFocusTarget {
      const element: CardDeletionFocusTarget = {
        isConnected: overrides.connected ?? true,
        tabIndex: overrides.tabIndex ?? 0,
        matches: () => overrides.disabled ?? false,
        focus: () => {
          focusCalls += 1
          if (overrides.receivesFocus ?? true) activeElement = element
        },
      }
      return element
    }

    assert.equal(tryRestoreCardDeletionFocus(target({ disabled: true }), () => activeElement), false)
    assert.equal(tryRestoreCardDeletionFocus(target({ connected: false }), () => activeElement), false)
    assert.equal(tryRestoreCardDeletionFocus(target({ tabIndex: -1 }), () => activeElement), false)
    assert.equal(focusCalls, 0)

    assert.equal(tryRestoreCardDeletionFocus(target({ receivesFocus: false }), () => activeElement), false)
    const fallback = target()
    assert.equal(tryRestoreCardDeletionFocus(fallback, () => activeElement), true)
    assert.equal(activeElement, fallback)
  })

  it('keeps focus on the persistent My Cards anchor across list replacement', () => {
    let activeElement: unknown = null
    let listConnected = true
    const removedList = {
      get isConnected() {
        return listConnected
      },
    }
    const disabledLaunch: CardDeletionFocusTarget = {
      isConnected: true,
      tabIndex: 0,
      matches: selector => selector.includes(':disabled'),
      focus: () => {
        activeElement = disabledLaunch
      },
    }
    const persistentAnchor: CardDeletionFocusTarget = {
      isConnected: true,
      tabIndex: -1,
      matches: () => false,
      focus: () => {
        activeElement = persistentAnchor
      },
    }

    assert.equal(
      restoreCardDeletionFocus(disabledLaunch, persistentAnchor, () => activeElement),
      true,
    )
    assert.equal(activeElement, persistentAnchor)

    listConnected = false
    const replacementList = { isConnected: true }
    assert.equal(removedList.isConnected, false)
    assert.equal(replacementList.isConnected, true)
    assert.equal(persistentAnchor.isConnected, true)
    assert.equal(activeElement, persistentAnchor)
  })

  it('removes exactly one requested identity without touching other cards', () => {
    const cards = [
      { cardId: 'card-1', title: 'One' },
      { cardId: 'card-10', title: 'Ten' },
      { cardId: 'CARD-1', title: 'Case' },
    ]
    assert.deepEqual(removeDeletedCard(cards, 'card-1'), [cards[1], cards[2]])
    assert.deepEqual(removeDeletedCard(cards, 'missing'), cards)
  })
})
