import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ClipboardPlus, FileClock, Plus } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { EmptyState, ErrorState, LoadingState } from "../components/StatePanel";
import { PageHeader } from "../components/PageHeader";
import { SyncStateBadge } from "../components/SyncStateBadge";
import type { LocalConsultation, LocalPatient } from "../database/types";
import { consultationRepository } from "../repositories/consultationRepository";
import { patientRepository } from "../repositories/patientRepository";
import { syncRepository, type RecordSyncState } from "../repositories/syncRepository";

export function ConsultationsPage() {
  const [searchParams] = useSearchParams();
  const [patients, setPatients] = useState<LocalPatient[]>([]);
  const [consultations, setConsultations] = useState<LocalConsultation[]>([]);
  const [states, setStates] = useState<Map<string, RecordSyncState>>(new Map());
  const [patientId, setPatientId] = useState(searchParams.get("patient") ?? "");
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    try {
      const [patientPage, consultationPage] = await Promise.all([
        patientRepository.listLocal({ pageSize: 500 }),
        consultationRepository.listLocal(1, 100),
      ]);
      setPatients(patientPage.items);
      setConsultations(consultationPage.items);
      setStates(
        await syncRepository.entityStates(
          consultationPage.items.map((item) => item.id),
        ),
      );
      setError("");
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Local consultations could not be read.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setMessage("");
    setSaving(true);
    try {
      const consultation = await consultationRepository.createLocal({
        patientId,
        reason: reason.trim(),
        notes: notes.trim(),
      });
      setNotes("");
      setReason("");
      setMessage(
        "Saved securely on this device. Waiting for internet connection to synchronize.",
      );
      await load();
      return consultation;
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The consultation could not be saved.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="CLINICAL DOCUMENTATION"
        title="Consultations"
        description="Consultations and their notes are written to this device first. SynCareX documents care; it does not diagnose or recommend treatment."
      />
      {message && (
        <div className="notice notice-success" role="status">
          {message}
        </div>
      )}
      {error && <ErrorState>{error}</ErrorState>}

      <section className="content-card consultation-editor">
        <div className="section-heading">
          <div>
            <h2>New consultation</h2>
            <p>Clinician-authored documentation for later review.</p>
          </div>
          <span className="draft-badge">
            <FileClock size={14} /> Draft
          </span>
        </div>
        {loading ? (
          <LoadingState label="Loading local patients..." />
        ) : patients.length ? (
          <form onSubmit={(event) => void submit(event)}>
            <div className="form-grid">
              <label className="form-field">
                <span>
                  Patient <b>*</b>
                </span>
                <select
                  onChange={(event) => setPatientId(event.target.value)}
                  required
                  value={patientId}
                >
                  <option value="">Select a local patient</option>
                  {patients.map((patient) => (
                    <option key={patient.id} value={patient.id}>
                      {patient.fullName} · {patient.patientNumber}
                    </option>
                  ))}
                </select>
              </label>
              <label className="form-field">
                <span>Reason for visit</span>
                <input
                  maxLength={240}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="For example: follow-up, fever review"
                  value={reason}
                />
              </label>
            </div>
            <label className="form-field consultation-notes">
              <span>Clinical notes</span>
              <textarea
                maxLength={20000}
                onChange={(event) => setNotes(event.target.value)}
                placeholder="Enter clinician-authored notes. Do not include inferred diagnoses or treatment recommendations."
                rows={7}
                value={notes}
              />
            </label>
            <div className="form-actions">
              <span className="form-hint">
                Persisted and encrypted locally before any network activity.
              </span>
              <button className="button button-primary" disabled={saving} type="submit">
                {saving ? (
                  "Saving on this device..."
                ) : (
                  <>
                    <ClipboardPlus size={16} /> Save consultation
                  </>
                )}
              </button>
            </div>
          </form>
        ) : (
          <EmptyState
            title="Register a patient first"
            description="Consultations are linked to an existing patient record stored in this local vault."
          />
        )}
      </section>

      <section className="dashboard-section">
        <div className="section-heading">
          <div>
            <h2>Recent consultations</h2>
            <p>{consultations.length} saved on this device</p>
          </div>
        </div>
        {loading ? (
          <LoadingState />
        ) : consultations.length ? (
          <div className="patient-list-card">
            {consultations.map((consultation) => {
              const patient = patients.find(
                (item) => item.id === consultation.patientId,
              );
              return (
                <Link
                  className="patient-row consultation-row"
                  key={consultation.id}
                  to={`/consultations/${consultation.id}`}
                >
                  <span className="patient-initials">
                    <ClipboardPlus size={17} />
                  </span>
                  <span className="patient-row-main">
                    <strong>{patient?.fullName ?? "Patient unavailable"}</strong>
                    <small>
                      {consultation.reason || "No reason recorded"} ·{" "}
                      {consultation.notes
                        ? `${consultation.notes.slice(0, 70)}${consultation.notes.length > 70 ? "…" : ""}`
                        : "No notes entered"}
                    </small>
                  </span>
                  <SyncStateBadge
                    state={states.get(consultation.id) ?? "saved_locally"}
                  />
                  <span className="patient-row-date">
                    {new Date(consultation.occurredAt).toLocaleString()}
                  </span>
                </Link>
              );
            })}
          </div>
        ) : (
          <EmptyState
            title="No consultations yet"
            description="Create one above; it is stored on this device and queued for synchronization."
            action={
              <span className="empty-caption">
                <Plus size={14} /> Start with the form above
              </span>
            }
          />
        )}
      </section>
    </>
  );
}
