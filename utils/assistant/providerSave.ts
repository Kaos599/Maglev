// SM-40 helper (pure): decides whether a finished provider probe may write the key and settings.
// The probe is a network call. While it runs the user can press "Remove key", which aborts it and deletes the
// key. A probe that still answers OK after that must not save anything, or the removed key comes back.

import type { ProviderState } from './providerMachine.ts';

/**
 * True only when this probe is still the one the screen is waiting for: it was not aborted, and the machine is
 * still in `testing`. SM-40 stores the key after PROBE_OK and never before.
 */
export function probeMayStore(args: { aborted: boolean; state: Pick<ProviderState, 'kind'> }): boolean {
  return !args.aborted && args.state.kind === 'testing';
}
