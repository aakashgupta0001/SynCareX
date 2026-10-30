import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  CloudUpload,
  GitCompareArrows,
  RefreshCw,
  ServerCrash,
  ShieldCheck,
  Wifi,
  WifiOff,
} from "lucide-react";
import { Link } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { EmptyState, ErrorState, LoadingState } from "../components/StatePanel";
import { syncRepository } from "../repositories/syncRepository";
import { useAuth } from "../services/auth";
import { useConnectivityState } from "../hooks/useConnectivity";
import { useSyncStatus } from "../hooks/useSyncStatus";
import { getLocalDeviceId } from "../offline/device";

function relative(timestamp: string | null): string {
  if (!timestamp) return "Never";
  const elapsed = Date.now() - Date.parse(timestamp);
  if (elapsed < 60_000) return "Just now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} min ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} h ago`;
  return new Date(timestamp).toLocaleString();
}

export function SyncPage() {
  const { session } = useAuth();
  const connectivity = useConnectivityState();
  const {
    operations,
    counts,
    conflicts,
    lastSuccessfulSyncAt,
    pending,
    loading,
    error,
    progress,
    syncing,
    refresh,
    runSync,
  } = useSyncStatus();
  const [deviceId, setDeviceId] = useState("");
  const [message, setMessage] = useState("");
  const [actionError, setActionError] = useState("");

  useEffect(() => {
    void getLocalDeviceId().then(setDeviceId);
  }, []);

  async function handleSync() {
    setMessage("");
    setActionError("");
    const outcome = await runSync();
    if (!outcome) return;
    if (outcome.skipped) setActionError(outcome.message);
    else setMessage(outcome.message);
  }

  async function handleRetryAll() {
    if (!session) return;
    setMessage("");
    setActionError("");
    const retried = await syncRepository.retryAllFailed(session.user.id);
    await refresh();
    setMessage(
      retried
        ? `${retried} failed operation(s) were queued for an immediate retry.`
        : "There are no failed operations to retry.",
    );
  }

  const connectionLabel = !connectivity.browserOnline
    ? "Offline · local changes are safe"
    : connectivity.apiUsable
      ? "Connected · synchronization available"
      : "API unreachable · local changes are safe";

  return (
    <>
      <PageHeader
        eyebrow="DURABLE OPERATION QUEUE"
        title="Sync center"
        description="Every change is written and encrypted on this device first. An operation is only marked synced once the server confirms it."
        action={
          <button
            className="button button-primary"
            disabled={syncing || !pending || !connectivity.apiUsable}
            onClick={() => void handleSync()}
            type="button"
          >
            <RefreshCw className={syncing ? "spin" : ""} size={16} />
            {syncing ? "Synchronizing..." : "Sync now"}
          </button>
        }
      />

      <div
        className={`sync-connectivity ${connectivity.apiUsable ? "sync-ready" : "sync-paused"}`}
      >
        {!connectivity.browserOnline ? (
          <WifiOff size={18} />
        ) : connectivity.apiUsable ? (
          <Wifi size={18} />
        ) : (
          <ServerCrash size={18} />
        )}
        <div>
          <strong>{connectionLabel}</strong>
          <span>
            {connectivity.lastHealthError ??
              "The SynCareX API answered the last health check."}
          </span>
        </div>
        <button
          className="button button-quiet"
          onClick={() => void connectivity.refresh()}
          type="button"
        >
          Check again
        </button>
      </div>

      <section aria-label="Synchronization summary" className="stats-grid">
        <article className="stat-card">
          <span className="stat-icon stat-icon-amber">
            <CloudUpload size={19} />
          </span>
          <span className="stat-label">Waiting to sync</span>
          <strong>{counts.pending + counts.retry_wait + counts.processing}</strong>
          <span className="stat-foot">Queued on this device</span>
        </article>
        <article className="stat-card">
          <span className="stat-icon stat-icon-blue">
            <AlertTriangle size={19} />
          </span>
          <span className="stat-label">Failed operations</span>
          <strong>{counts.failed}</strong>
          <span className="stat-foot">Requires manual review or retry</span>
        </article>
        <article className="stat-card">
          <span className="stat-icon stat-icon-teal">
            <GitCompareArrows size={19} />
          </span>
          <span className="stat-label">Conflicts</span>
          <strong>{conflicts}</strong>
          <span className="stat-foot">Need clinician review</span>
        </article>
        <article className="stat-card">
          <span className="stat-icon stat-icon-green">
            <ShieldCheck size={19} />
          </span>
          <span className="stat-label">Last successful sync</span>
          <strong className="stat-word">{relative(lastSuccessfulSyncAt)}</strong>
          <span className="stat-foot">{counts.acknowledged} acknowledged in total</span>
        </article>
      </section>

      {progress && (
        <div className="sync-progress" role="status">
          <div className="sync-progress-bar">
            <span
              style={{
                width: `${progress.total ? Math.round((progress.completed / progress.total) * 100) : 10}%`,
              }}
            />
          </div>
          <span>{progress.message}</span>
        </div>
      )}
      {message && (
        <div className="notice notice-success" role="status">
          <Check size={16} />
          {message}
        </div>
      )}
      {(actionError || error) && <ErrorState>{actionError || error}</ErrorState>}
      {conflicts > 0 && (
        <div className="notice notice-warn">
          <GitCompareArrows size={17} />
          {conflicts} record(s) need clinician review before they can synchronize.{" "}
          <Link to="/conflicts">Open conflict review</Link>
        </div>
      )}

      <section className="content-card sync-queue">
        <div className="section-heading">
          <div>
            <h2>Device operation queue</h2>
            <p>
              Device ID · <code>{deviceId || "Loading…"}</code>
            </p>
          </div>
          <div className="section-actions">
            <button
              className="button button-quiet"
              disabled={!counts.failed}
              onClick={() => void handleRetryAll()}
              type="button"
            >
              Retry failed
            </button>
            <span className="encrypted-pill">
              <ShieldCheck size={14} /> Encrypted payloads
            </span>
          </div>
        </div>
        {loading ? (
          <LoadingState label="Loading durable queue..." />
        ) : operations.length ? (
          <div className="operation-list">
            {operations.map((operation) => (
              <article className="operation-row" key={operation.operationId}>
                <span className={`operation-status status-${operation.status}`}>
                  <span />
                  {operation.status}
                </span>
                <div className="operation-main">
                  <strong>
                    {operation.operationType} {operation.entityType}
                  </strong>
                  <small>
                    v{operation.baseVersion} → v{operation.localVersion} · key{" "}
                    {operation.idempotencyKey.slice(0, 12)}…
                  </small>
                  {operation.lastError && (
                    <p className="operation-error">{operation.lastError}</p>
                  )}
                </div>
                <span className="operation-retries">
                  {operation.retryCount} attempt(s)
                  {(operation.status === "failed" || operation.status === "retry_wait") && (
                    <small>next {relative(operation.nextAttemptAt)}</small>
                  )}
                </span>
                <div className="operation-actions">
                  <time>{new Date(operation.createdAt).toLocaleString()}</time>
                  {operation.status === "failed" && (
                    <button
                      className="button button-quiet"
                      onClick={() =>
                        void syncRepository
                          .retryNow(operation.operationId)
                          .then(refresh)
                      }
                      type="button"
                    >
                      Retry now
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <EmptyState
            title="Queue is clear"
            description="Operations appear here as soon as a patient, consultation, note or document is saved on this device."
          />
        )}
      </section>
    </>
  );
}
