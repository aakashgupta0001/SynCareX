import { useCallback, useEffect, useMemo, useState } from "react";
import { syncRepository } from "../repositories/syncRepository";
import { conflictRepository } from "../repositories/conflictRepository";
import { loadLastSuccessfulSync } from "../services/connectivity";
import {
  syncNow,
  startSyncScheduler,
  type SyncOutcome,
  type SyncProgress,
} from "../services/syncEngine";
import type { OperationStatus, SyncOperation } from "../database/types";
import { useAuth } from "../services/auth";

export interface SyncStatus {
  operations: SyncOperation[];
  counts: Record<OperationStatus, number>;
  conflicts: number;
  lastSuccessfulSyncAt: string | null;
  loading: boolean;
  error: string;
}

const emptyCounts: Record<OperationStatus, number> = {
  pending: 0,
  processing: 0,
  retry_wait: 0,
  failed: 0,
  acknowledged: 0,
  conflict: 0,
  superseded: 0,
};

/**
 * Reads the durable queue for display. Everything here is derived from
 * IndexedDB, so the numbers survive a restart exactly as the records do.
 */
export function useSyncStatus(pollMs = 5000) {
  const { session } = useAuth();
  const ownerId = session?.user.id ?? null;
  const [status, setStatus] = useState<SyncStatus>({
    operations: [],
    counts: emptyCounts,
    conflicts: 0,
    lastSuccessfulSyncAt: null,
    loading: true,
    error: "",
  });
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [syncing, setSyncing] = useState(false);

  const refresh = useCallback(async () => {
    if (!ownerId) return;
    try {
      const [operations, counts, conflicts, lastSync] = await Promise.all([
        syncRepository.list(ownerId),
        syncRepository.countByStatus(ownerId),
        conflictRepository.countOpen(ownerId),
        loadLastSuccessfulSync(),
      ]);
      setStatus({
        operations,
        counts,
        conflicts,
        lastSuccessfulSyncAt: lastSync,
        loading: false,
        error: "",
      });
    } catch (reason) {
      setStatus((current) => ({
        ...current,
        loading: false,
        error:
          reason instanceof Error
            ? reason.message
            : "The local synchronization queue could not be read.",
      }));
    }
  }, [ownerId]);

  useEffect(() => {
    void refresh();
    if (!pollMs) return;
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [refresh, pollMs]);

  const runSync = useCallback(async (): Promise<SyncOutcome | null> => {
    if (!ownerId) return null;
    setSyncing(true);
    try {
      const outcome = await syncNow(ownerId, setProgress);
      await refresh();
      return outcome;
    } finally {
      setSyncing(false);
      setProgress(null);
    }
  }, [ownerId, refresh]);

  const pending = useMemo(
    () =>
      status.counts.pending +
      status.counts.retry_wait +
      status.counts.failed +
      status.counts.processing,
    [status.counts],
  );

  return { ...status, pending, progress, syncing, refresh, runSync };
}

/** Starts automatic synchronization for the signed-in user. */
export function useAutoSync(onOutcome?: (outcome: SyncOutcome) => void) {
  const { session } = useAuth();
  const ownerId = session?.user.id ?? null;
  useEffect(() => {
    if (!ownerId) return;
    return startSyncScheduler(ownerId, onOutcome);
    // The handler is intentionally not a dependency; the scheduler lives for
    // as long as the session does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerId]);
}
