// SM-42 Chat session. Pure: no React, no IO. app/assistant.tsx runs the effects.
// History lives in memory only in v1 (caption: "Chats aren't saved."). Anything not in the table is a no-op.
// Never add states. CLEAR is valid in every state. It goes through `cleared`, which is transient, so the reducer returns `empty` directly.

export type SessionKind = 'empty' | 'active' | 'backgrounded';

export interface SessionState {
  kind: SessionKind;
}

export type SessionEvent =
  | { type: 'SEND'; text: string }
  | { type: 'APP_BACKGROUND' }
  | { type: 'APP_FOREGROUND' }
  | { type: 'CLEAR' }
  | { type: 'KEY_REMOVED' };

export type SessionEffect =
  | { type: 'send'; text: string }
  | { type: 'abort' }
  | { type: 'expireAllCards' }
  | { type: 'dropHistory' };

export interface SessionStep {
  state: SessionState;
  effects: SessionEffect[];
}

export const SESSION_INITIAL: SessionState = { kind: 'empty' };

/** Fixed caption under the chat input (SM-42). */
export const SESSION_NOT_SAVED_CAPTION = "Chats aren't saved.";

const CLEAR_EFFECTS: SessionEffect[] = [{ type: 'expireAllCards' }, { type: 'dropHistory' }];

/** One step of the SM-42 machine. Returns the next state and the effects to run. */
export function sessionStep(state: SessionState, event: SessionEvent): SessionStep {
  const same: SessionStep = { state, effects: [] };

  // Any state: removing the key and CLEAR end the session. Clearing an empty chat is harmless and idempotent.
  if (event.type === 'KEY_REMOVED' || event.type === 'CLEAR') {
    return { state: { kind: 'empty' }, effects: [...CLEAR_EFFECTS] };
  }

  switch (state.kind) {
    case 'empty': {
      if (event.type === 'SEND') {
        return { state: { kind: 'active' }, effects: [{ type: 'send', text: event.text }] };
      }
      return same;
    }
    case 'active': {
      if (event.type === 'APP_BACKGROUND') {
        return { state: { kind: 'backgrounded' }, effects: [{ type: 'abort' }] };
      }
      // Later messages in an active chat go to the turn machine.
      if (event.type === 'SEND') return { state, effects: [{ type: 'send', text: event.text }] };
      return same;
    }
    case 'backgrounded': {
      if (event.type === 'APP_FOREGROUND') return { state: { kind: 'active' }, effects: [] };
      return same;
    }
    default:
      return same;
  }
}
