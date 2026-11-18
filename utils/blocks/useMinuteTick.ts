import { useEffect, useState } from 'react';

/** Re-renders once a minute while `active`, so a clock time such as "Resumes at 07:05" never goes stale. Returns the current time. */
export function useMinuteTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}
