import { useCallback, useEffect, useState } from "react";
import { GitCompareArrows, Laptop, Server, ShieldAlert } from "lucide-react";
import { EmptyState, ErrorState, LoadingState } from "../components/StatePanel";
import { PageHeader } from "../components/PageHeader";
import type { SyncConflict } from "../database/types";
import {
  conflictRepository,
  normalizeToApiFields,
  type ConflictFieldChoice,
  type ConflictFieldDiff,
} from "../repositories/conflictRepository";
import { useAuth } from "../services/auth";

interface ConflictView {
  conflict: SyncConflict;
  base: Record<string, unknown>;
  diffs: ConflictFieldDiff[];
}

/** Per-conflict picks: field name → which side kept. */
type Picks = Record<string, Record<string, ConflictFieldChoice>>;

function format(value: unknown): string {
  if (value === undefined) return "—";
  if (value === null) return "Not recorded";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "None";
  return String(value);
}

function baseValueFor(view: ConflictView, field: string): unknown {
  return view.base[field];
}

export function ConflictsPage() {
  const { session } = useAuth();
  const ownerId = session?.user.id ?? "";
  const [views, setViews] = useState<ConflictView[]>([]);
  const [picks, setPicks] = useState<Picks>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    if (!ownerId) return;
    try {
      const conflicts = await conflictRepository.listOpen(ownerId);
      const resolved = await Promise.all(
        conflicts.map(async (conflict) => {
          const [payloads, diffs] = await Promise.all([
            conflictRepository.readPayloads(conflict),
            conflictRepository.diffConflict(conflict),
          ]);
          return {
            conflict,
            base: normalizeToApiFields(conflict.entityType, payloads.base),
            diffs,
          };
        }),
      );
      setViews(resolved);
      // Undecided fields default to the server value: the safe side until
      // the clinician actively chooses this device's version.
      setPicks((previous) => {
        const next: Picks = { ...previous };
        for (const view of resolved) {
          const row: Record<string, ConflictFieldChoice> = {};
          for (const diff of view.diffs) {
            if (!diff.differs) continue;
            row[diff.field] = previous[view.conflict.id]?.[diff.field] ?? "server";
          }
          next[view.conflict.id] = row;
        }
        return next;
      });
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

  function setPick(conflictId: string, field: string, choice: ConflictFieldChoice) {
    setPicks((previous) => ({
      ...previous,
      [conflictId]: { ...previous[conflictId], [field]: choice },
    }));
  }

  function setAll(conflictId: string, choice: ConflictFieldChoice) {
    const view = views.find((item) => item.conflict.id === conflictId);
    if (!view) return;
    const row: Record<string, ConflictFieldChoice> = {};
    for (const diff of view.diffs) {
      if (diff.differs) row[diff.field] = choice;
    }
    setPicks((previous) => ({ ...previous, [conflictId]: row }));
  }

  async function resolve(conflictId: string) {
    setBusy(conflictId);
    setMessage("");
    try {
      await conflictRepository.resolveConflictFields(
        conflictId,
        picks[conflictId] ?? {},
      );
      setMessage(
        "Your field choices were applied. The locally-kept fields were re-queued against the current server version, and the decision was recorded for synchronization.",
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
        description="When two devices change the same record, both versions are kept until an authorized clinician decides. Choose a version per field, or keep one side wholesale; nothing is merged or overwritten automatically."
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
          {views.map((view) => {
            const conflictPicks = picks[view.conflict.id] ?? {};
            const differing = view.diffs.filter((diff) => diff.differs);
            return (
              <section className="content-card conflict-card" key={view.conflict.id}>
                <div className="section-heading">
                  <div>
                    <h2>
                      {view.conflict.entityType} · base version{" "}
                      {view.conflict.baseVersion} · local{" "}
                      {view.conflict.localVersion} vs{" "}
                      {view.conflict.serverVersion ?? "unknown"}
                    </h2>
                    <p>{view.conflict.message}</p>
                    <small className="form-hint">
                      Change submitted{" "}
                      {new Date(
                        view.conflict.operationCreatedAt ?? view.conflict.detectedAt,
                      ).toLocaleString()}
                      {view.conflict.actorId ? ` · actor ${view.conflict.actorId}` : ""}
                      {view.conflict.deviceId ? ` · device ${view.conflict.deviceId}` : ""}
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
                        <th>Keep</th>
                      </tr>
                    </thead>
                    <tbody>
                      {view.diffs.map((diff) => {
                        const choice = differing.some(
                          (item) => item.field === diff.field,
                        )
                          ? (conflictPicks[diff.field] ?? "server")
                          : null;
                        return (
                          <tr className={diff.differs ? "conflict-differs" : ""} key={diff.field}>
                            <td>{diff.field}</td>
                            <td>{format(baseValueFor(view, diff.field))}</td>
                            <td>{format(diff.localValue)}</td>
                            <td>{format(diff.serverValue)}</td>
                            <td>
                              {choice === null ? (
                                <span className="form-hint">Identical</span>
                              ) : (
                                <span
                                  className="field-choice"
                                  role="radiogroup"
                                  aria-label={`Keep ${diff.field} from`}
                                >
                                  <label>
                                    <input
                                      checked={choice === "local"}
                                      disabled={busy === view.conflict.id}
                                      name={`${view.conflict.id}-${diff.field}`}
                                      onChange={() =>
                                        setPick(view.conflict.id, diff.field, "local")
                                      }
                                      type="radio"
                                    />{" "}
                                    Device
                                  </label>
                                  <label>
                                    <input
                                      checked={choice === "server"}
                                      disabled={busy === view.conflict.id}
                                      name={`${view.conflict.id}-${diff.field}`}
                                      onChange={() =>
                                        setPick(view.conflict.id, diff.field, "server")
                                      }
                                      type="radio"
                                    />{" "}
                                    Server
                                  </label>
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="form-hint">
                  Differing fields: {differing.map((diff) => diff.field).join(", ") || "none"}.
                  Fields the two versions agree on need no decision.
                  {Object.keys(view.base).length === 0 &&
                    " The original base snapshot is unavailable for this stored operation."}
                </p>

                <div className="form-actions">
                  <span className="form-hint">
                    Detected {new Date(view.conflict.detectedAt).toLocaleString()}. Both
                    versions remain stored until you choose.
                  </span>
                  <button
                    className="button button-quiet"
                    disabled={busy === view.conflict.id}
                    onClick={() => setAll(view.conflict.id, "server")}
                    type="button"
                  >
                    Use server for all fields
                  </button>
                  <button
                    className="button button-quiet"
                    disabled={busy === view.conflict.id}
                    onClick={() => setAll(view.conflict.id, "local")}
                    type="button"
                  >
                    Use this device for all fields
                  </button>
                  <button
                    className="button button-primary"
                    disabled={busy === view.conflict.id}
                    onClick={() => void resolve(view.conflict.id)}
                    type="button"
                  >
                    Apply selected fields
                  </button>
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <EmptyState
          title="No conflicts to review"
          description="A conflict appears here when the server already holds a newer version of a record this device edited."
        />
      )}

      <div className="notice notice-info">
        <GitCompareArrows size={17} /> Applying your choices re-queues only the
        locally-kept fields against the current server version, records the
        decision (who, when, which version won) for synchronization, and never
        silently discards the other clinician's edit. A field you leave on
        "Server" keeps the server's value.
      </div>
    </>
  );
}
