// SM-39 Plan card (multi-step, one Confirm). Pure: no React, no IO. The component runs the effects.
// A plan is an ordered list of steps; each step is a proposal card body (SM-38 execute per step).
// Anything not in the transition table is a no-op. Never add states.

export const MAX_PLAN_STEPS = 6;

export type PlanKind = 'proposed' | 'running' | 'done' | 'halted' | 'expired' | 'dismissed';

export interface StepCheck {
  ok: boolean;
  reason?: string;
}

export interface PlanState {
  kind: PlanKind;
  /** Number of steps in the plan (1..MAX_PLAN_STEPS). */
  total: number;
  /** Index of the running or failed step (SM-39 running(i) / halted(i, reason)). */
  index?: number;
  /** Steps that failed revalidation on the last Confirm, with their reasons. */
  invalid?: { step: number; reason?: string }[];
  /** Failure message for a halted plan. */
  reason?: string;
  /** Summary line after the last step finishes, e.g. "Done: 3 steps.". */
  summary?: string;
}

export type PlanEvent =
  | { type: 'CONFIRM'; checks: StepCheck[] }
  | { type: 'STEP_OK' }
  | { type: 'STEP_ERR'; message: string }
  | { type: 'RETRY' }
  | { type: 'DISMISS' }
  | { type: 'EXPIRE' };

export type PlanEffect =
  | { type: 'execute'; step: number }
  | { type: 'revalidate'; step: number }
  | { type: 'markInvalid'; step: number; reason?: string }
  | { type: 'halt'; step: number; message: string; notRun: number[] }
  | { type: 'summary'; text: string };

export interface PlanStep {
  state: PlanState;
  effects: PlanEffect[];
}

/** True when a plan has between 1 and MAX_PLAN_STEPS steps. */
export function planSizeOk(total: number): boolean {
  return Number.isInteger(total) && total >= 1 && total <= MAX_PLAN_STEPS;
}

/** Initial state for a new plan card. Callers must check planSizeOk first. */
export function planInitial(total: number): PlanState {
  return { kind: 'proposed', total };
}

/** Indices that have not run yet after a halt at `step` (SM-39 "Not run"). */
export function planNotRun(total: number, step: number): number[] {
  const out: number[] = [];
  for (let i = step + 1; i < total; i++) out.push(i);
  return out;
}

/** One step of the SM-39 machine. Returns the next state and the effects to run. */
export function planStep(state: PlanState, event: PlanEvent): PlanStep {
  const same: PlanStep = { state, effects: [] };
  const { total } = state;
  const last = total - 1;

  switch (state.kind) {
    case 'proposed': {
      if (event.type === 'CONFIRM') {
        if (!planSizeOk(total)) return same;
        const invalid: { step: number; reason?: string }[] = [];
        event.checks.forEach((check, step) => {
          if (!check.ok) invalid.push({ step, reason: check.reason });
        });
        if (invalid.length > 0) {
          return {
            state: { ...state, invalid },
            effects: invalid.map((s) => ({ type: 'markInvalid' as const, step: s.step, reason: s.reason })),
          };
        }
        return {
          state: { kind: 'running', total, index: 0 },
          effects: [{ type: 'execute', step: 0 }],
        };
      }
      if (event.type === 'DISMISS') return { state: { ...state, kind: 'dismissed' }, effects: [] };
      if (event.type === 'EXPIRE') return { state: { ...state, kind: 'expired' }, effects: [] };
      return same;
    }
    case 'running': {
      const i = state.index ?? 0;
      if (event.type === 'STEP_OK') {
        if (i < last) {
          return {
            state: { kind: 'running', total, index: i + 1 },
            effects: [
              { type: 'revalidate', step: i + 1 },
              { type: 'execute', step: i + 1 },
            ],
          };
        }
        const summary = `Done: ${total} steps.`;
        return { state: { kind: 'done', total, summary }, effects: [{ type: 'summary', text: summary }] };
      }
      if (event.type === 'STEP_ERR') {
        return {
          state: { kind: 'halted', total, index: i, reason: event.message },
          effects: [{ type: 'halt', step: i, message: event.message, notRun: planNotRun(total, i) }],
        };
      }
      return same;
    }
    case 'halted': {
      if (event.type === 'RETRY') {
        const i = state.index ?? 0;
        return {
          state: { kind: 'running', total, index: i },
          effects: [
            { type: 'revalidate', step: i },
            { type: 'execute', step: i },
          ],
        };
      }
      if (event.type === 'DISMISS') return { state: { ...state, kind: 'dismissed' }, effects: [] };
      if (event.type === 'EXPIRE') return { state: { ...state, kind: 'expired' }, effects: [] };
      return same;
    }
    default:
      // done, expired, dismissed: terminal.
      return same;
  }
}
