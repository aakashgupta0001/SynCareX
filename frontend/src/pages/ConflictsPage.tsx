import { useCallback, useEffect, useState } from "react";
import { GitCompareArrows, Laptop, Server, ShieldAlert } from "lucide-react";
import { EmptyState, ErrorState, LoadingState } from "../components/StatePanel";
import { PageHeader } from "../components/PageHeader";
import type { SyncConflict } from "../database/types";
import { conflictRepository } from "../repositories/conflictRepository";
import { useAuth } from "../services/auth";

interface ConflictView {
  conflict: SyncConflict;
  base: Record<string, unknown> | null;
  local: Record<string, unknown> | null;
  server: Record<string, unknown> | null;
}

function fieldRows(
  base: Record<string, unknown> | null,
  local: Record<string, unknown> | null,
  server: Record<string, unknown> | null,
): { field: string; base: string; local: string; server: string; differs: boolean }[] {
  const keys = [
    ...new Set([
      ...Object.keys(base ?? {}),
      ...Object.keys(local ?? {}),
      ...Object.keys(server ?? {}),
    ]),
  ].filter((key) => key !== "expected_version");
  return keys.map((field) => {
    const baseValue = format(base?.[field]);
    const localValue = format(local?.[field]);
    const serverValue = format(server?.[field]);
    return {
      field,
      base: baseValue,
      local: localValue,
      server: serverValue,
      differs: localValue !== serverValue,
    };
  });
}

function changedFields(
  base: Record<string, unknown> | null,
  local: Record<string, unknown> | null,
): string[] {
  const keys = new Set([
    ...Object.keys(base ?? {}),
    ...Object.keys(local ?? {}),
  ]);
  if (!base) return [...keys].filter((key) => key !== "expected_version");
  return [...keys].filter(
    (key) => key !== "expected_version" && format(base[key]) !== format(local?.[key]),
  );
}

function format(value: unknown): string {
  if (value === undefined) return "—";
  if (value === null) return "Not recorded";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "None";
  return String(value);
}

export function ConflictsPage() {
  const { session } = useAuth();
  const ownerId = session?.user.id ?? "";
  const [views, setViews] = useState<ConflictView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    if (!ownerId) return;
    try {
      const conflicts = await conflictRepository.listOpen(ownerId);
      const resolved = await Promise.all(
        conflicts.map(async (conflict) => ({
          conflict,
          ...(await conflictRepository.readPayloads(conflict)),
        })),
      );
      setViews(resolved);
      setError("");
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The conflicting changes could not be read.",
      );
    } finally {
      setLoading(false);
    }
  }, [ownerId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function resolve(conflictId: string, keep: "local" | "server") {
    setBusy(conflictId);
    setMessage("");
    try {
      if (keep === "local") await conflictRepository.resolveKeepLocal(conflictId);
      else await conflictRepository.resolveKeepServer(conflictId);
      setMessage(
        keep === "local"
          ? "This device's version was kept and re-queued against the current server version."
          : "The server version was kept. Your local attempt is retained in the conflict history.",
      );
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "The conflict could not be resolved.",
      );
    } finally {
      setBusy("");
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="CLINICAL DATA INTEGRITY"
        title="Conflict review"
        description="When two devices change the same record, both versions are kept until an authorized clinician decides. Nothing is merged or overwritten automatically."
      />
      {error && <ErrorState>{error}</ErrorState>}
      {message && (
        <div className="notice notice-success" role="status">
          {message}
        </div>
      )}

      {loading ? (
        <LoadingState label="Reading conflicting versions..." />
      ) : views.length ? (
        <div className="conflict-list">
          {views.map(({ conflict, base, local, server }) => (
            <section className="content-card conflict-card" key={conflict.id}>
              <div className="section-heading">
                <div>
                  <h2>
                    {conflict.entityType} · base version {conflict.baseVersion} · local{" "}
                    {conflict.localVersion} vs{" "}
                    {conflict.serverVersion ?? "unknown"}
                  </h2>
                  <p>{conflict.message}</p>
                  <small className="form-hint">
                    Change submitted {new Date(
                      conflict.operationCreatedAt ?? conflict.detectedAt,
                    ).toLocaleString()}
                    {conflict.actorId ? ` · actor ${conflict.actorId}` : ""}
                    {conflict.deviceId ? ` · device ${conflict.deviceId}` : ""}
                  </small>
                </div>
                <span className="conflict-pill">
                  <ShieldAlert size={14} /> Needs review
                </span>
              </div>

              <div className="conflict-table-wrap">
                <table className="conflict-table">
                  <thead>
                    <tr>
                      <th>Field</th>
                      <th>Original base</th>
                      <th>
                        <Laptop size={14} /> This device
                      </th>
                      <th>
                        <Server size={14} /> Server
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {fieldRows(base, local, server).map((row) => (
                      <tr className={row.differs ? "conflict-differs" : ""} key={row.field}>
                        <td>{row.field}</td>
                        <td>{row.base}</td>
                        <td>{row.local}</td>
                        <td>{row.server}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="form-hint">
                Changed fields: {changedFields(base, local).join(", ") || "not available"}.
                {!base && " The original base snapshot is unavailable for this stored operation."}
              </p>

              <div className="form-actions">
                <span className="form-hint">
                  Detected {new Date(conflict.detectedAt).toLocaleString()}. Both
                  versions remain stored until you choose.
                </span>
                <button
                  className="button button-quiet"
                  disabled={busy === conflict.id}
                  onClick={() => void resolve(conflict.id, "server")}
                  type="button"
                >
                  Keep server version
                </button>
                <button
                  className="button button-primary"
                  disabled={busy === conflict.id}
                  onClick={() => void resolve(conflict.id, "local")}
                  type="button"
                >
                  Keep this device's version
                </button>
              </div>
            </section>
          ))}
        </div>
      ) : (
        <EmptyState
          title="No conflicts to review"
          description="A conflict appears here when the server already holds a newer version of a record this device edited."
        />
      )}

      <div className="notice notice-info">
        <GitCompareArrows size={17} /> Keeping this device's version re-queues the
        change against the current server version; it never silently discards the
        other clinician's edit.
      </div>
    </>
  );
}
