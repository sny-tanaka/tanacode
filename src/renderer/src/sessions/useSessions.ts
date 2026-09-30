import { useEffect, useState } from 'react';
import type { SessionSummary } from '@shared/ipc';

export function useSessions(): SessionSummary[] | null {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  useEffect(() => {
    const off = window.tanacode.sessions.onChanged(setSessions);
    void window.tanacode.sessions.list().then((list) => setSessions((prev) => prev ?? list));
    return off;
  }, []);
  return sessions;
}
