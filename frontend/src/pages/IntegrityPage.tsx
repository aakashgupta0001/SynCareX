import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  CircleHelp,
  ExternalLink,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { Link } from "react-router-dom";
import { EmptyState, ErrorState, LoadingState } from "../components/StatePanel";
import { PageHeader } from "../components/PageHeader";
import { useAuth } from "../services/auth";
import type {
  IntegrityFindingStatus,
  IntegritySeverity,
} from "../database/types";
import {
  integrityRepository,
  type DecryptedIntegrityFinding,
} from "../repositories/integrityRepository";

const severityOrder: Record<IntegritySeverity, number> = {
  high: 0,
  medium: 1,
  low: 2,
  info: 3,
};

function findingLink(finding: DecryptedIntegrityFinding): string | null {
  if (finding.entityType === "patient") return `/patients/${finding.entityId}`;
  if (finding.entityType === "consultation") return "/consultations";
  if (finding.entityType === "aiArtifact") return "/ai";
  if (finding.category === "sync") return "/sync";
  return null;
}

function evidenceText(value: unknown): string {
  if (value === null || value === undefined || value === "") return "Not recorded";
  return String(value);
}

export function IntegrityPage() {
  const { session } = useAuth();
  const canReview = session?.permissions.includes("patients.write") ?? false;
  const [findings, setFindings] = useState<DecryptedIntegrityFinding[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [rationales, setRationales] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    try {
      setFindings(await integrityRepository.listLocal());
      setError("");
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Local integrity findings could not be read.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  const scan = useCallback(async () => {
    setScanning(true);
    setMessage("");
    try {
      setFindings(await integrityRepository.scanLocal());
      setError("");
      setMessage("Local integrity checks completed. Clinical records were not changed.");
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The integrity checks could not be completed.",
      );
    } finally {
      setScanning(false);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = findings
    .filter((finding) =>
      showHistory
        ? finding.status === "resolved" || finding.status === "dismissed"
        : finding.status === "open" || finding.status === "acknowledged",
    )
    .sort((left, right) =>
      severityOrder[left.severity] - severityOrder[right.severity] ||
      right.detectedAt.localeCompare(left.detectedAt),
    );

  async function review(
    findingId: string,
    status: IntegrityFindingStatus,
  ) {
    setBusy(findingId);
    setError("");
    setMessage("");
    try {
      await integrityRepository.review(
        findingId,
        status,
        rationales[findingId] ?? "",
      );
      setRationales((current) => ({ ...current, [findingId]: "" }));
      setMessage("Review decision saved on this device and added to the audit history.");
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The review decision could not be saved.",
      );
    } finally {
      setBusy("");
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="LOCAL DATA QUALITY"
        title="Integrity guardian"
        description="Deterministic checks run against this device's decrypted local view. Findings are encrypted at rest; they never alter clinical records or merge patient profiles."
        action={
          <button
            className="button button-primary"
            disabled={scanning}
            onClick={() => void scan()}
            type="button"
          >
            <RefreshCw size={15} className={scanning ? "spin" : undefined} />
            {scanning ? "Checking local records..." : "Run checks"}
          </button>
        }
      />

      <div className="notice notice-warn" role="note">
        <AlertTriangle size={17} />
        <span>
          Findings are prompts to verify source records, not diagnoses or
          treatment recommendations. Duplicate candidates must be reviewed by a
          clinician; this phase does not merge or delete records.
        </span>
      </div>
      {message && (
        <div className="notice notice-success" role="status">
          <Check size={17} /> {message}
        </div>
      )}
      {error && <ErrorState>{error}</ErrorState>}
      {!canReview && (
        <div className="notice notice-info" role="status">
          This account can review findings but cannot record resolution actions.
        </div>
      )}
      <div className="integrity-toolbar">
        <label className="integrity-history-toggle">
          <input
            checked={showHistory}
            onChange={(event) => setShowHistory(event.target.checked)}
            type="checkbox"
          />
          Show resolved and dismissed findings
        </label>
        <span>{visible.length} finding(s) in this view</span>
      </div>

      {loading ? (
        <LoadingState label="Reading encrypted integrity findings..." />
      ) : visible.length ? (
        <div className="integrity-list">
          {visible.map((finding) => {
            const link = findingLink(finding);
            const patients = Array.isArray(finding.evidenceValue.patients)
              ? finding.evidenceValue.patients as Record<string, unknown>[]
              : [];
            const affectedIds = Array.isArray(finding.evidenceValue.observationIds)
              ? finding.evidenceValue.observationIds.map(String)
              : [];
            const invalidFactIndexes = Array.isArray(
              finding.evidenceValue.invalidFactIndexes,
            )
              ? finding.evidenceValue.invalidFactIndexes
              : [];
            const hiddenEvidence = new Set([
              "patients",
              "observations",
              "observationIds",
              "invalidFactIndexes",
            ]);
            const evidenceEntries = Object.entries(finding.evidenceValue).filter(
              ([key, value]) => !hiddenEvidence.has(key) && value !== null,
            );
            return (
              <article className="content-card integrity-card" key={finding.id}>
                <div className="integrity-card-heading">
                  <span className={`integrity-severity integrity-severity-${finding.severity}`}>
                    {finding.severity}
                  </span>
                  <span className={`integrity-status integrity-status-${finding.status}`}>
                    {finding.status.replaceAll("_", " ")}
                  </span>
                  <time>{new Date(finding.detectedAt).toLocaleString()}</time>
                </div>
                <div className="section-heading">
                  <div>
                    <h2>{finding.title}</h2>
                    <p>{finding.summary}</p>
                  </div>
                  {link && (
                    <Link className="text-link" to={link}>
                      Review record <ExternalLink size={14} />
                    </Link>
                  )}
                </div>

                {patients.length > 0 && (
                  <div className="integrity-patient-pair">
                    {patients.map((patient) => (
                      <div key={String(patient.id)}>
                        <strong>{evidenceText(patient.fullName)}</strong>
                        <span>{evidenceText(patient.patientNumber)}</span>
                        <small>
                          DOB: {evidenceText(patient.dateOfBirth)} · Phone:{" "}
                          {evidenceText(patient.phone)}
                        </small>
                        <Link className="text-link" to={`/patients/${String(patient.id)}`}>
                          Open patient
                        </Link>
                      </div>
                    ))}
                    <p>
                      Match basis: {evidenceText(finding.evidenceValue.matchReason)}
                    </p>
                  </div>
                )}
                {affectedIds.length > 0 && (
                  <p className="form-hint">
                    Affected measurement IDs: {affectedIds.join(", ")}
                  </p>
                )}
                {evidenceEntries.length > 0 && (
                  <dl className="integrity-evidence">
                    {evidenceEntries.map(([key, value]) => (
                      <div key={key}>
                        <dt>{key.replaceAll("_", " ")}</dt>
                        <dd>
                          {Array.isArray(value)
                            ? value.map(String).join(", ")
                            : typeof value === "object"
                              ? JSON.stringify(value)
                              : evidenceText(value)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
                {invalidFactIndexes.length > 0 && (
                  <p className="form-hint">
                    Statements needing source review:{" "}
                    {invalidFactIndexes.map((item) => Number(item) + 1).join(", ")}
                  </p>
                )}

                {finding.status === "resolved" || finding.status === "dismissed" ? (
                  <>
                    <p className="integrity-rationale">
                      Review note: {finding.rationale || "No manual rationale recorded."}
                    </p>
                    {canReview && (
                      <button
                        className="button button-quiet"
                        disabled={busy === finding.id}
                        onClick={() => void review(finding.id, "open")}
                        type="button"
                      >
                        Reopen finding
                      </button>
                    )}
                  </>
                ) : canReview ? (
                  <div className="integrity-review">
                    <label>
                      <span>
                        Review note
                        <small> · required to dismiss or resolve</small>
                      </span>
                      <input
                        onChange={(event) =>
                          setRationales((current) => ({
                            ...current,
                            [finding.id]: event.target.value,
                          }))
                        }
                        placeholder={
                          finding.category === "duplicate"
                            ? "e.g. Verified as two different people"
                            : "Record what was checked or corrected"
                        }
                        value={rationales[finding.id] ?? ""}
                      />
                    </label>
                    <div className="form-actions">
                      <button
                        className="button button-quiet"
                        disabled={busy === finding.id}
                        onClick={() => void review(finding.id, "acknowledged")}
                        type="button"
                      >
                        <CircleHelp size={15} /> Acknowledge
                      </button>
                      <button
                        className="button button-secondary"
                        disabled={busy === finding.id}
                        onClick={() => void review(finding.id, "resolved")}
                        type="button"
                      >
                        <ShieldCheck size={15} /> Mark resolved
                      </button>
                      <button
                        className="button button-quiet"
                        disabled={busy === finding.id}
                        onClick={() => void review(finding.id, "dismissed")}
                        type="button"
                      >
                        {finding.category === "duplicate"
                          ? "Dismiss as distinct patients"
                          : "Dismiss finding"}
                      </button>
                    </div>
                  </div>
                ) : null}
                {finding.reviewedBy && (
                  <small className="integrity-reviewed">
                    Reviewed by {finding.reviewedBy} ·{" "}
                    {finding.reviewedAt
                      ? new Date(finding.reviewedAt).toLocaleString()
                      : "time unavailable"}
                  </small>
                )}
              </article>
            );
          })}
        </div>
      ) : (
        <EmptyState
          title={showHistory ? "No resolved findings yet" : "No open findings"}
          description={
            showHistory
              ? "Resolved and dismissed checks will remain available here for local review."
              : "Run a check to look for duplicate candidates, inconsistent references, source-provenance gaps, and stalled synchronization."
          }
        />
      )}
    </>
  );
}
