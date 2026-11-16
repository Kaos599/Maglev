import type { UpdateState } from '../../../utils/update/machine';
import { useManagedCheck, useUpdateState } from '../../../utils/update';

/** The update this state is about, when there is one the card can show. */
export function updateInfoOf(s: UpdateState) {
  return 'info' in s ? s.info : null;
}

/** Whether a newer version is waiting, and which one (shared by About and Updates). */
export function useHasUpdate() {
  const update = useUpdateState();
  const managedCheck = useManagedCheck();
  const info = updateInfoOf(update);
  const newerManaged = managedCheck.status === 'newer' ? managedCheck.info : null;
  const hasUpdate = (info !== null && update.kind !== 'done') || newerManaged !== null;
  const version = (info?.version ?? newerManaged?.version) as string | undefined;
  return { update, managedCheck, info, newerManaged, hasUpdate, version };
}
