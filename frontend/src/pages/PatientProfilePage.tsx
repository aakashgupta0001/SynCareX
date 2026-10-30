import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  Archive,
  CalendarDays,
  ClipboardPlus,
  Edit3,
  FileText,
  IdCard,
  MapPin,
  Phone,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { Link, useLocation, useParams } from "react-router-dom";
import { ErrorState, LoadingState } from "../components/StatePanel";
import { PageHeader } from "../components/PageHeader";
import { LocalSaveNotice, SyncStateBadge } from "../components/SyncStateBadge";
import type {
  LocalConsultation,
  LocalDocument,
  LocalPatient,
  LocalPatientIdentifier,
} from "../database/types";
import {
  patientIdentifierRepository,
  patientRepository,
} from "../repositories/patientRepository";
import { consultationRepository } from "../repositories/consultationRepository";
import { documentRepository } from "../repositories/documentRepository";
import { syncRepository, type RecordSyncState } from "../repositories/syncRepository";
import { formatBytes } from "../offline/storage";
import { api, mapPatientFromApi } from "../services/api";
import { useAuth } from "../services/auth";
import { useConnectivityState } from "../hooks/useConnectivity";

export function PatientProfilePage() {
  const { patientId = "" } = useParams();
  const { session } = useAuth();
  const { apiUsable } = useConnectivityState();
  const location = useLocation();
  const [patient, setPatient] = useState<LocalPatient | null>(null);
  const [identifiers, setIdentifiers] = useState<LocalPatientIdentifier[]>([]);
  const [consultations, setConsultations] = useState<LocalConsultation[]>([]);
  const [documents, setDocuments] = useState<LocalDocument[]>([]);
  const [state, setState] = useState<RecordSyncState>("saved_locally");
  const [identifierSystem, setIdentifierSystem] = useState("");
  const [identifierValue, setIdentifierValue] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    try {
      let record = await patientRepository.getLocal(patientId);
      if (!record && apiUsable && session?.mode === "online") {
        record = mapPatientFromApi(await api.getPatient(patientId));
        await patientRepository.cacheServerPatient(record);
      }
      if (!record) {
        throw new Error(
          "This patient record is not stored on this device and the server is unreachable.",
        );
      }
      setPatient(record);
      const [identifierList, consultationList, documentList, recordState] =
        await Promise.all([
          patientIdentifierRepository.listByPatientLocal(patientId),
          consultationRepository.listByPatientLocal(patientId),
          documentRepository.listByPatientLocal(patientId),
          syncRepository.entityState(patientId),
        ]);
      setIdentifiers(identifierList);
      setConsultations(consultationList);
      setDocuments(documentList);
      setState(recordState);
      setError("");
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The patient record could not be opened.",
      );
    } finally {
      setLoading(false);
    }
  }, [apiUsable, patientId, session?.mode]);

  useEffect(() => {
    void load();
  }, [load]);

  async function addIdentifier(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setMessage("");
    try {
      await patientIdentifierRepository.createLocal({
        patientId,
        system: identifierSystem.trim(),
        value: identifierValue.trim(),
      });
      setIdentifierSystem("");
      setIdentifierValue("");
      setMessage(
        "Identifier saved securely on this device. Waiting for internet connection to synchronize.",
      );
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The identifier could not be saved.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function archive() {
    if (!patient) return;
    setSaving(true);
    setError("");
    try {
      await patientRepository.archiveLocal(patient.id);
      setMessage(
        "The record was archived on this device and queued. Nothing was deleted.",
      );
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "The record could not be archived.",
      );
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <LoadingState label="Opening patient record..." />;
  if (error && !patient) return <ErrorState>{error}</ErrorState>;
  if (!patient) return <ErrorState>Patient record unavailable.</ErrorState>;
  const notice = (location.state as { notice?: string } | null)?.notice;

  return (
    <>
      <Link className="back-link" to="/patients">
        <ArrowLeft size={16} /> Patient directory
      </Link>
      {notice && (
        <div className="notice notice-success" role="status">
          <ShieldCheck size={17} />
          {notice}
        </div>
      )}
      {message && (
        <div className="notice notice-success" role="status">
          {message}
        </div>
      )}
      {error && <ErrorState>{error}</ErrorState>}
      <PageHeader
        eyebrow={patient.patientNumber}
        title={patient.fullName}
        description={`Patient profile · Updated ${new Date(patient.updatedAt).toLocaleString()}${patient.archivedAt ? " · Archived" : ""}`}
        action={
          <Link className="button button-secondary" to={`/patients/${patient.id}/edit`}>
            <Edit3 size={16} /> Edit details
          </Link>
        }
      />
      <LocalSaveNotice state={state} />

      <div className="profile-summary-grid">
        <article className="profile-summary-card">
          <span className="summary-icon">
            <UserRound size={18} />
          </span>
          <span className="summary-label">Demographics</span>
          <strong>
            {patient.estimatedAge !== null
              ? `${patient.estimatedAge} years (estimated)`
              : patient.dateOfBirth || "Age not recorded"}
          </strong>
          <small>{patient.gender || "Gender not recorded"}</small>
        </article>
        <article className="profile-summary-card">
          <span className="summary-icon">
            <Phone size={18} />
          </span>
          <span className="summary-label">Contact</span>
          <strong>{patient.contactPhone || "Not recorded"}</strong>
          <small>{patient.emergencyContactName || "No emergency contact recorded"}</small>
        </article>
        <article className="profile-summary-card">
          <span className="summary-icon">
            <MapPin size={18} />
          </span>
          <span className="summary-label">Location</span>
          <strong>{patient.village || "Not recorded"}</strong>
          <small>{patient.address || "No address recorded"}</small>
        </article>
        <article className="profile-summary-card">
          <span className="summary-icon">
            <CalendarDays size={18} />
          </span>
          <span className="summary-label">Record version</span>
          <strong>Version {patient.version}</strong>
          <small>
            <SyncStateBadge state={state} />
          </small>
        </article>
      </div>

      <div className="profile-columns">
        <section className="content-card">
          <div className="section-heading">
            <div>
              <h2>Clinical context</h2>
              <p>Recorded information; not a diagnosis.</p>
            </div>
          </div>
          <div className="detail-block">
            <span>Known allergies</span>
            <div className="allergy-list">
              {patient.allergies.length ? (
                patient.allergies.map((allergy) => (
                  <span className="allergy-chip" key={allergy}>
                    {allergy}
                  </span>
                ))
              ) : (
                <span className="detail-muted">No allergies recorded</span>
              )}
            </div>
          </div>
          <div className="detail-block">
            <span>Relevant history</span>
            <p>{patient.relevantHistory || "No relevant history recorded."}</p>
          </div>
          <div className="detail-block">
            <span>Emergency contact</span>
            <p>
              {patient.emergencyContactName || "Not recorded"}
              {patient.emergencyContactPhone ? ` · ${patient.emergencyContactPhone}` : ""}
            </p>
          </div>
        </section>

        <section className="content-card">
          <div className="section-heading">
            <div>
              <h2>Patient identifiers</h2>
              <p>Programme or national identifiers recorded for this patient.</p>
            </div>
          </div>
          {identifiers.length ? (
            <div className="identifier-list">
              {identifiers.map((identifier) => (
                <span className="identifier-chip" key={identifier.id}>
                  <IdCard size={14} />
                  <strong>{identifier.system}</strong>
                  <code>{identifier.value}</code>
                </span>
              ))}
            </div>
          ) : (
            <p className="detail-muted">No identifiers recorded yet.</p>
          )}
          <form onSubmit={(event) => void addIdentifier(event)}>
            <div className="form-grid">
              <label className="form-field">
                <span>
                  System <b>*</b>
                </span>
                <input
                  maxLength={120}
                  onChange={(event) => setIdentifierSystem(event.target.value)}
                  placeholder="For example: clinic card"
                  required
                  value={identifierSystem}
                />
              </label>
              <label className="form-field">
                <span>
                  Value <b>*</b>
                </span>
                <input
                  maxLength={160}
                  onChange={(event) => setIdentifierValue(event.target.value)}
                  required
                  value={identifierValue}
                />
              </label>
            </div>
            <div className="form-actions">
              <button className="button button-secondary" disabled={saving} type="submit">
                Add identifier
              </button>
            </div>
          </form>
        </section>
      </div>

      <div className="profile-columns">
        <section className="content-card">
          <div className="section-heading">
            <div>
              <h2>Consultations</h2>
              <p>{consultations.length} stored on this device</p>
            </div>
            <Link className="button button-quiet" to={`/consultations?patient=${patient.id}`}>
              <ClipboardPlus size={16} /> New consultation
            </Link>
          </div>
          {consultations.length ? (
            <div className="timeline">
              {consultations.map((consultation) => (
                <Link
                  className="timeline-entry"
                  key={consultation.id}
                  to={`/consultations/${consultation.id}`}
                >
                  <span className="timeline-dot" />
                  <div>
                    <strong>{consultation.reason || "Consultation"}</strong>
                    <small>{new Date(consultation.occurredAt).toLocaleString()}</small>
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <p className="detail-muted">No consultations recorded yet.</p>
          )}
        </section>

        <section className="content-card">
          <div className="section-heading">
            <div>
              <h2>Documents</h2>
              <p>{documents.length} stored on this device</p>
            </div>
            <Link className="button button-quiet" to="/documents">
              <FileText size={16} /> Manage documents
            </Link>
          </div>
          {documents.length ? (
            <div className="attachment-list">
              {documents.map((document) => (
                <span className="attachment-chip" key={document.id}>
                  <FileText size={14} />
                  {document.fileName}
                  <small>{formatBytes(document.byteSize)}</small>
                </span>
              ))}
            </div>
          ) : (
            <p className="detail-muted">No documents stored for this patient.</p>
          )}
        </section>
      </div>

      {!patient.archivedAt && (
        <div className="danger-row">
          <div>
            <strong>Archive this record</strong>
            <p>
              Archiving hides the record from the directory and queues the change.
              Clinical records are never deleted from this device.
            </p>
          </div>
          <button
            className="button button-quiet"
            disabled={saving}
            onClick={() => void archive()}
            type="button"
          >
            <Archive size={16} /> Archive record
          </button>
        </div>
      )}
    </>
  );
}
