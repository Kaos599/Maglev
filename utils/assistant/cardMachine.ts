// SM-38 Proposal card. Pure: no React, no IO. The component runs the effects.
// Anything not in the transition table is a no-op. Never add states.

export type CardKind = 'proposed' | 'confirming' | 'executing' | 'done' | 'failed' | 'expired' | 'dismissed';

export interface CardState {
  kind: CardKind;
  cardId: string;
  /** Why the card stopped being valid on the last Confirm (shown on the card). */
  reason?: string;
  /** One-line result after EXEC_OK. */
  summary?: string;
  /** Message after EXEC_ERR (the SM-36 message for the code, chosen by the caller). */
  error?: string;
  /** Caption shown on an expired card. */
  caption?: string;
}

export type CardEvent =
  | { type: 'CONFIRM' }
  | { type: 'DISMISS' }
  | { type: 'REVALIDATED'; ok: boolean; reason?: string }
  | { type: 'EXEC_OK'; summary: string }
  | { type: 'EXEC_ERR'; code: string; message: string }
  | { type: 'EXPIRE' }
  | { type: 'RETRY' };

export type CardEffect =
  | { type: 'revalidate'; cardId: string }
  | { type: 'execute'; cardId: string }
  | { type: 'appendToolNote'; cardId: string; payload: { executed: true } };

export interface CardStep {
  state: CardState;
  effects: CardEffect[];
}

/** Fixed copy for an expired card (SM-38). */
export const CARD_EXPIRED_CAPTION = 'Expired. Ask again for a fresh plan.';

/** One step of the SM-38 machine. Returns the next state and the effects to run. */
export function cardStep(state: CardState, event: CardEvent): CardStep {
  const same: CardStep = { state, effects: [] };
  const id = state.cardId;
  switch (state.kind) {
    case 'proposed': {
      if (event.type === 'CONFIRM') {
        return {
          state: { kind: 'confirming', cardId: id },
          effects: [{ type: 'revalidate', cardId: id }],
        };
      }
      if (event.type === 'DISMISS') return { state: { ...state, kind: 'dismissed' }, effects: [] };
      if (event.type === 'EXPIRE') {
        return { state: { ...state, kind: 'expired', caption: CARD_EXPIRED_CAPTION }, effects: [] };
      }
      return same;
    }
    case 'confirming': {
      if (event.type === 'REVALIDATED') {
        if (event.ok) {
          return { state: { kind: 'executing', cardId: id }, effects: [{ type: 'execute', cardId: id }] };
        }
        return { state: { kind: 'proposed', cardId: id, reason: event.reason }, effects: [] };
      }
      // EXPIRE never interrupts an action in flight.
      return same;
    }
    case 'executing': {
      if (event.type === 'EXEC_OK') {
        return {
          state: { kind: 'done', cardId: id, summary: event.summary },
          effects: [{ type: 'appendToolNote', cardId: id, payload: { executed: true } }],
        };
      }
      if (event.type === 'EXEC_ERR') {
        return { state: { kind: 'failed', cardId: id, error: event.message }, effects: [] };
      }
      return same;
    }
    case 'failed': {
      if (event.type === 'RETRY') {
        return { state: { kind: 'confirming', cardId: id }, effects: [{ type: 'revalidate', cardId: id }] };
      }
      if (event.type === 'DISMISS') return { state: { ...state, kind: 'dismissed' }, effects: [] };
      if (event.type === 'EXPIRE') {
        return { state: { ...state, kind: 'expired', caption: CARD_EXPIRED_CAPTION }, effects: [] };
      }
      return same;
    }
    default:
      // done, dismissed, expired: terminal.
      return same;
  }
}

/**
 * What to report to the turn machine as `CardSettled{cardId, kind}` after a cardMachine step.
 * Returns null while the card is still live (proposed, confirming, executing). `failed` stays pending in the
 * turn machine because the card can be retried.
 */
export function cardSettledKind(state: CardState): 'done' | 'dismissed' | 'expired' | 'failed' | null {
  switch (state.kind) {
    case 'done':
    case 'dismissed':
    case 'expired':
    case 'failed':
      return state.kind;
    default:
      return null;
  }
}
