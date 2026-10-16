import { useCallback, useEffect, useRef, useState } from 'react';
import { call } from './api';
import { toast } from './store';

/** Robot actions with a busy flag and toasts, like the app's VacuumViewModel.run. */
export function useRobotActions(duid: string) {
  const [busyCount, setBusyCount] = useState(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const run = useCallback(async <T = null>(name: string, args: Record<string, unknown> = {}, success?: string): Promise<T | undefined> => {
    setBusyCount((n) => n + 1);
    try {
      const result = await call<T>(duid, name, args);
      if (success) toast(success);
      return result;
    } catch (e) {
      toast((e as Error).message || 'Something went wrong', true);
      return undefined;
    } finally {
      if (mounted.current) setBusyCount((n) => Math.max(0, n - 1));
    }
  }, [duid]);
  /** Same, but quiet on failure: for background reads. */
  const read = useCallback(async (name: string, args: Record<string, unknown> = {}) => {
    try {
      await call(duid, name, args);
      return true;
    } catch {
      return false;
    }
  }, [duid]);
  return { run, read, busy: busyCount > 0 };
}
