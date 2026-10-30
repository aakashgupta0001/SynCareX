import { useCallback, useEffect, useState } from "react";
import { History, Laptop, Server } from "lucide-react";
import { PageHeader } from "../components/PageHeader";
import { EmptyState, ErrorState, LoadingState } from "../components/StatePanel";
import { auditRepository } from "../repositories/auditRepository";
import { api } from "../services/api";
import { useAuth } from "../services/auth";
import { useConnectivityState } from "../hooks/useConnectivity";
import type { AuditEvent } from "../database/types";

interface ServerEvent {
  id: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  outcome: string;
  created_at: string;
}

export function AuditPage() {
  const { session } = useAuth();
  const { apiUsable } = useConnectivityState();
  const [localEvents, setLocalEvents] = useState<AuditEvent[]>([]);
  const [serverEvents, setServerEvents] = useState<ServerEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [warning, setWarning] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!session) return;
    try {
      setLocalEvents(await auditRepository.list(session.user.id));
      if (apiUsable && session.mode === "online") {
        try {
          const response = await api.listAudit();
          setServerEvents(response.items);
          setWarning("");
        } catch (reason) {
          setWarning(
            reason instanceof Error
              ? `Server audit history unavailable: ${reason.message}`
              : "Server audit history unavailable.",
          );
        }
      } else {
        setWarning(
          "Offline: showing only the audit events recorded on this device.",
        );
      }
      setError("");
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The audit history could not be read.",
      );
    } finally {
      setLoading(false);
    }
  }, [apiUsable, session]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <PageHeader
        eyebrow="CLINICAL ACCOUNTABILITY"
        title="Audit history"
        description="Clinically relevant changes are recorded on this device as they happen, and on the server once they synchronize. Event details are encrypted locally."
      />
      {warning && (
        <div className="notice notice-info" role="status">
          {warning}
        </div>
      )}
      {error && <ErrorState>{error}</ErrorState>}

      {loading ? (
        <LoadingState label="Reading audit history..." />
      ) : (
        <div className="profile-columns">
          <section className="content-card">
            <div className="section-heading">
              <div>
                <h2>
                  <Laptop size={16} /> On this device
                </h2>
                <p>{localEvents.length} event(s)</p>
              </div>
            </div>
            {localEvents.length ? (
              <div className="audit-list">
                {localEvents.map((event) => (
                  <article className="audit-row" key={event.id}>
                    <span className="audit-action">{event.action}</span>
                    <small>
                      {event.entityType}
                      {event.entityId ? ` · ${event.entityId.slice(0, 8)}…` : ""}
                    </small>
                    <time>{new Date(event.createdAt).toLocaleString()}</time>
                  </article>
                ))}
              </div>
            ) : (
              <EmptyState
                title="No local events yet"
                description="Creating or editing a clinical record records an event here."
              />
            )}
          </section>

          <section className="content-card">
            <div className="section-heading">
              <div>
                <h2>
                  <Server size={16} /> On the server
                </h2>
                <p>{serverEvents.length} event(s)</p>
              </div>
            </div>
            {serverEvents.length ? (
              <div className="audit-list">
                {serverEvents.map((event) => (
                  <article className="audit-row" key={event.id}>
                    <span className="audit-action">{event.action}</span>
                    <small>
                      {event.entity_type} · {event.outcome}
                    </small>
                    <time>{new Date(event.created_at).toLocaleString()}</time>
                  </article>
                ))}
              </div>
            ) : (
              <EmptyState
                title="No server events available"
                description="Server audit history requires an authenticated online session."
              />
            )}
          </section>
        </div>
      )}

      <div className="notice notice-info">
        <History size={17} /> Local audit details are stored as encrypted envelopes;
        no patient information is written to the console, a URL or a log file.
      </div>
    </>
  );
}
