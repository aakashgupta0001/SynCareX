import {
  AlertTriangle,
  CheckCircle2,
  CloudOff,
  CloudUpload,
  GitCompareArrows,
  HardDriveDownload,
  RefreshCw,
} from "lucide-react";
import {
  recordStateCopy,
  type RecordSyncState,
} from "../repositories/syncRepository";

const icons: Record<RecordSyncState, typeof CloudOff> = {
  saved_locally: HardDriveDownload,
  waiting_to_sync: CloudUpload,
  syncing: RefreshCw,
  synced: CheckCircle2,
  sync_failed: AlertTriangle,
  conflict: GitCompareArrows,
};

/**
 * One visual vocabulary for record state across the workspace. "Synced" is
 * only ever shown for a record the server has confirmed.
 */
export function SyncStateBadge({
  state,
  withDetail = false,
}: {
  state: RecordSyncState;
  withDetail?: boolean;
}) {
  const Icon = icons[state];
  const copy = recordStateCopy[state];
  return (
    <span className={`sync-badge sync-badge-${state}`} title={copy.detail}>
      <Icon aria-hidden="true" className={state === "syncing" ? "spin" : ""} size={14} />
      <span>{copy.label}</span>
      {withDetail && <small>{copy.detail}</small>}
    </span>
  );
}

/** The longer sentence used under forms after a local save. */
export function LocalSaveNotice({ state }: { state: RecordSyncState }) {
  return (
    <div className={`local-save-notice notice-${state}`} role="status">
      <SyncStateBadge state={state} />
      <p>{recordStateCopy[state].detail}</p>
    </div>
  );
}
