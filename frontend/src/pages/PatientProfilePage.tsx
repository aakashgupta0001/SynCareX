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
  Save,
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
  LocalAllergy,
  LocalMedication,
  LocalObservation,
  LocalPatient,
  LocalPatientIdentifier,
} from "../database/types";
import {
  patientIdentifierRepository,
  patientRepository,
} from "../repositories/patientRepository";
import {
  allergyRepository,
  consultationRepository,
  medicationRepository,
  observationRepository,
} from "../repositories/consultationRepository";
import { documentRepository } from "../repositories/documentRepository";
import { syncRepository, type RecordSyncState } from "../repositories/syncRepository";
import { formatBytes } from "../offline/storage";
import { api, mapPatientFromApi } from "../services/api";
import { useAuth } from "../services/auth";
import { useConnectivityState } from "../hooks/useConnectivity";

type ClinicalRecordType = "observation" | "allergy" | "medication";

interface ClinicalEditDraft {
  recordId: string;
  type: ClinicalRecordType;
  values: Record<string, string>;
}

interface ClinicalArchiveDraft {
  recordId: string;
  type: ClinicalRecordType;
  reason: string;
}

function formatLocalDateTimeInput(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function PatientProfilePage() {
  const { patientId = "" } = useParams();
  const { session } = useAuth();
  const { apiUsable } = useConnectivityState();
  const location = useLocation();
  const [patient, setPatient] = useState<LocalPatient | null>(null);
  const [identifiers, setIdentifiers] = useState<LocalPatientIdentifier[]>([]);
  const [consultations, setConsultations] = useState<LocalConsultation[]>([]);
  const [documents, setDocuments] = useState<LocalDocument[]>([]);
  const [observations, setObservations] = useState<LocalObservation[]>([]);
  const [allergies, setAllergies] = useState<LocalAllergy[]>([]);
  const [medications, setMedications] = useState<LocalMedication[]>([]);
  const [editDraft, setEditDraft] = useState<ClinicalEditDraft | null>(null);
  const [archiveDraft, setArchiveDraft] = useState<ClinicalArchiveDraft | null>(null);
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
      const [
        identifierList,
        consultationList,
        documentList,
        observationList,
        allergyList,
        medicationList,
        recordState,
      ] =
        await Promise.all([
          patientIdentifierRepository.listByPatientLocal(patientId),
          consultationRepository.listByPatientLocal(patientId),
          documentRepository.listByPatientLocal(patientId),
          observationRepository.listByPatientLocal(patientId),
          allergyRepository.listByPatientLocal(patientId),
          medicationRepository.listByPatientLocal(patientId),
          syncRepository.entityState(patientId),
        ]);
      setIdentifiers(identifierList);
      setConsultations(consultationList);
      setDocuments(documentList);
      setObservations(observationList);
      setAllergies(allergyList);
      setMedications(medicationList);
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

  async function saveClinicalEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editDraft) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const values = editDraft.values;
      if (editDraft.type === "observation") {
        await observationRepository.updateLocal(editDraft.recordId, {
          code: values.code.trim(),
          label: values.label.trim(),
          value: values.value.trim(),
          unit: values.unit.trim(),
          recordedAt: new Date(values.recordedAt).toISOString(),
        });
      } else if (editDraft.type === "allergy") {
        await allergyRepository.updateLocal(editDraft.recordId, {
          substance: values.substance.trim(),
          reaction: values.reaction.trim(),
          severity: values.severity as LocalAllergy["severity"],
        });
      } else {
        await medicationRepository.updateLocal(editDraft.recordId, {
          name: values.name.trim(),
          dose: values.dose.trim(),
          frequency: values.frequency.trim(),
          startedAt: values.startedAt || null,
        });
      }
      setEditDraft(null);
      setMessage(
        "Clinical record updated on this device and queued for version-checked synchronization.",
      );
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "The clinical record could not be updated.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function markEnteredInError(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!archiveDraft) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      if (archiveDraft.type === "observation") {
        await observationRepository.archiveLocal(archiveDraft.recordId, archiveDraft.reason);
      } else if (archiveDraft.type === "allergy") {
        await allergyRepository.archiveLocal(archiveDraft.recordId, archiveDraft.reason);
      } else {
        await medicationRepository.archiveLocal(archiveDraft.recordId, archiveDraft.reason);
      }
      setArchiveDraft(null);
      setMessage(
        "The record was marked entered in error, retained, and queued for version-checked synchronization.",
      );
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "The clinical record could not be archived.",
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
              <h2>Allergy records</h2>
              <p>Correct records or mark them entered in error; records are retained.</p>
            </div>
          </div>
          {allergies.length ? (
            <div className="note-list">
              {allergies.map((allergy) => (
                <article className="note-entry" key={allergy.id}>
                  <strong>{allergy.substance}</strong>
                  <p>
                    {allergy.reaction || "Reaction not recorded"} · {allergy.severity}
                  </p>
                  <small>
                    v{allergy.version} · Recorded {new Date(allergy.recordedAt).toLocaleString()}
                  </small>
                  {allergy.enteredInErrorAt ? (
                    <small role="status">
                      Entered in error {new Date(allergy.enteredInErrorAt).toLocaleString()}
                      {allergy.enteredInErrorReason
                        ? ` · ${allergy.enteredInErrorReason}`
                        : ""}
                    </small>
                  ) : (
                    <div className="form-actions">
                      <button
                        aria-label={`Edit allergy ${allergy.substance}`}
                        className="button button-quiet"
                        disabled={saving}
                        onClick={() => {
                          setArchiveDraft(null);
                          setEditDraft({
                            recordId: allergy.id,
                            type: "allergy",
                            values: {
                              substance: allergy.substance,
                              reaction: allergy.reaction,
                              severity: allergy.severity,
                            },
                          });
                        }}
                        type="button"
                      >
                        <Edit3 size={15} /> Edit
                      </button>
                      <button
                        aria-label={`Mark allergy ${allergy.substance} entered in error`}
                        className="button button-quiet"
                        disabled={saving}
                        onClick={() => {
                          setEditDraft(null);
                          setArchiveDraft({
                            recordId: allergy.id,
                            type: "allergy",
                            reason: "",
                          });
                        }}
                        type="button"
                      >
                        <Archive size={15} /> Mark entered in error
                      </button>
                    </div>
                  )}
                  {editDraft?.recordId === allergy.id && (
                    <form className="clinical-edit-form" onSubmit={(event) => void saveClinicalEdit(event)}>
                      <label className="form-field">
                        <span>Substance</span>
                        <input
                          maxLength={160}
                          onChange={(event) =>
                            setEditDraft((current) =>
                              current
                                ? { ...current, values: { ...current.values, substance: event.target.value } }
                                : current,
                            )
                          }
                          required
                          value={editDraft.values.substance}
                        />
                      </label>
                      <label className="form-field">
                        <span>Reaction</span>
                        <input
                          maxLength={240}
                          onChange={(event) =>
                            setEditDraft((current) =>
                              current
                                ? { ...current, values: { ...current.values, reaction: event.target.value } }
                                : current,
                            )
                          }
                          value={editDraft.values.reaction}
                        />
                      </label>
                      <label className="form-field">
                        <span>Severity</span>
                        <select
                          onChange={(event) =>
                            setEditDraft((current) =>
                              current
                                ? { ...current, values: { ...current.values, severity: event.target.value } }
                                : current,
                            )
                          }
                          value={editDraft.values.severity}
                        >
                          {(["unknown", "mild", "moderate", "severe"] as const).map((severity) => (
                            <option key={severity} value={severity}>{severity}</option>
                          ))}
                        </select>
                      </label>
                      <div className="form-actions">
                        <button className="button button-primary" disabled={saving} type="submit">
                          <Save size={15} /> Save changes
                        </button>
                        <button className="button button-quiet" onClick={() => setEditDraft(null)} type="button">
                          Cancel
                        </button>
                      </div>
                    </form>
                  )}
                  {archiveDraft?.recordId === allergy.id && (
                    <form className="clinical-edit-form" onSubmit={(event) => void markEnteredInError(event)}>
                      <label className="form-field">
                        <span>Reason for marking entered in error <b>*</b></span>
                        <textarea
                          maxLength={500}
                          minLength={3}
                          onChange={(event) =>
                            setArchiveDraft((current) =>
                              current ? { ...current, reason: event.target.value } : current,
                            )
                          }
                          required
                          rows={2}
                          value={archiveDraft.reason}
                        />
                      </label>
                      <div className="form-actions">
                        <button className="button button-secondary" disabled={saving} type="submit">
                          Confirm entered in error
                        </button>
                        <button className="button button-quiet" onClick={() => setArchiveDraft(null)} type="button">
                          Cancel
                        </button>
                      </div>
                    </form>
                  )}
                </article>
              ))}
            </div>
          ) : (
            <p className="detail-muted">No structured allergy records stored on this device.</p>
          )}
        </section>

        <section className="content-card">
          <div className="section-heading">
            <div>
              <h2>Medication records</h2>
              <p>Documentation only; edits are queued and version-checked.</p>
            </div>
          </div>
          {medications.length ? (
            <div className="note-list">
              {medications.map((medication) => (
                <article className="note-entry" key={medication.id}>
                  <strong>{medication.name}</strong>
                  <p>
                    {[medication.dose, medication.frequency].filter(Boolean).join(" · ") || "Dose/frequency not recorded"}
                  </p>
                  <small>
                    v{medication.version}
                    {medication.startedAt ? ` · Started ${medication.startedAt}` : ""}
                  </small>
                  {medication.enteredInErrorAt ? (
                    <small role="status">
                      Entered in error {new Date(medication.enteredInErrorAt).toLocaleString()}
                      {medication.enteredInErrorReason
                        ? ` · ${medication.enteredInErrorReason}`
                        : ""}
                    </small>
                  ) : (
                    <div className="form-actions">
                      <button
                        aria-label={`Edit medication ${medication.name}`}
                        className="button button-quiet"
                        disabled={saving}
                        onClick={() => {
                          setArchiveDraft(null);
                          setEditDraft({
                            recordId: medication.id,
                            type: "medication",
                            values: {
                              name: medication.name,
                              dose: medication.dose,
                              frequency: medication.frequency,
                              startedAt: medication.startedAt ?? "",
                            },
                          });
                        }}
                        type="button"
                      >
                        <Edit3 size={15} /> Edit
                      </button>
                      <button
                        aria-label={`Mark medication ${medication.name} entered in error`}
                        className="button button-quiet"
                        disabled={saving}
                        onClick={() => {
                          setEditDraft(null);
                          setArchiveDraft({
                            recordId: medication.id,
                            type: "medication",
                            reason: "",
                          });
                        }}
                        type="button"
                      >
                        <Archive size={15} /> Mark entered in error
                      </button>
                    </div>
                  )}
                  {editDraft?.recordId === medication.id && (
                    <form className="clinical-edit-form" onSubmit={(event) => void saveClinicalEdit(event)}>
                      <label className="form-field">
                        <span>Medication name</span>
                        <input
                          maxLength={160}
                          onChange={(event) =>
                            setEditDraft((current) =>
                              current ? { ...current, values: { ...current.values, name: event.target.value } } : current,
                            )
                          }
                          required
                          value={editDraft.values.name}
                        />
                      </label>
                      <div className="form-grid">
                        <label className="form-field">
                          <span>Dose</span>
                          <input
                            maxLength={120}
                            onChange={(event) =>
                              setEditDraft((current) =>
                                current ? { ...current, values: { ...current.values, dose: event.target.value } } : current,
                              )
                            }
                            value={editDraft.values.dose}
                          />
                        </label>
                        <label className="form-field">
                          <span>Frequency</span>
                          <input
                            maxLength={120}
                            onChange={(event) =>
                              setEditDraft((current) =>
                                current ? { ...current, values: { ...current.values, frequency: event.target.value } } : current,
                              )
                            }
                            value={editDraft.values.frequency}
                          />
                        </label>
                        <label className="form-field">
                          <span>Started at</span>
                          <input
                            onChange={(event) =>
                              setEditDraft((current) =>
                                current ? { ...current, values: { ...current.values, startedAt: event.target.value } } : current,
                              )
                            }
                            type="date"
                            value={editDraft.values.startedAt}
                          />
                        </label>
                      </div>
                      <div className="form-actions">
                        <button className="button button-primary" disabled={saving} type="submit">
                          <Save size={15} /> Save changes
                        </button>
                        <button className="button button-quiet" onClick={() => setEditDraft(null)} type="button">
                          Cancel
                        </button>
                      </div>
                    </form>
                  )}
                  {archiveDraft?.recordId === medication.id && (
                    <form className="clinical-edit-form" onSubmit={(event) => void markEnteredInError(event)}>
                      <label className="form-field">
                        <span>Reason for marking entered in error <b>*</b></span>
                        <textarea
                          maxLength={500}
                          minLength={3}
                          onChange={(event) =>
                            setArchiveDraft((current) =>
                              current ? { ...current, reason: event.target.value } : current,
                            )
                          }
                          required
                          rows={2}
                          value={archiveDraft.reason}
                        />
                      </label>
                      <div className="form-actions">
                        <button className="button button-secondary" disabled={saving} type="submit">
                          Confirm entered in error
                        </button>
                        <button className="button button-quiet" onClick={() => setArchiveDraft(null)} type="button">
                          Cancel
                        </button>
                      </div>
                    </form>
                  )}
                </article>
              ))}
            </div>
          ) : (
            <p className="detail-muted">No medication records stored on this device.</p>
          )}
        </section>
      </div>

      <section className="content-card">
        <div className="section-heading">
          <div>
            <h2>Vital signs and observations</h2>
            <p>Correct the recorded value or retain it with an entered-in-error reason.</p>
          </div>
        </div>
        {observations.length ? (
          <div className="note-list">
            {observations.map((observation) => (
              <article className="note-entry" key={observation.id}>
                <strong>{observation.label}: {observation.value}{observation.unit ? ` ${observation.unit}` : ""}</strong>
                <small>
                  v{observation.version} · {new Date(observation.recordedAt).toLocaleString()}
                </small>
                {observation.enteredInErrorAt ? (
                  <small role="status">
                    Entered in error {new Date(observation.enteredInErrorAt).toLocaleString()}
                    {observation.enteredInErrorReason ? ` · ${observation.enteredInErrorReason}` : ""}
                  </small>
                ) : (
                  <div className="form-actions">
                    <button
                      aria-label={`Edit observation ${observation.label}`}
                      className="button button-quiet"
                      disabled={saving}
                      onClick={() => {
                        setArchiveDraft(null);
                        setEditDraft({
                          recordId: observation.id,
                          type: "observation",
                          values: {
                            code: observation.code,
                            label: observation.label,
                            value: observation.value,
                            unit: observation.unit,
                            recordedAt: formatLocalDateTimeInput(observation.recordedAt),
                          },
                        });
                      }}
                      type="button"
                    >
                      <Edit3 size={15} /> Edit
                    </button>
                    <button
                      aria-label={`Mark observation ${observation.label} entered in error`}
                      className="button button-quiet"
                      disabled={saving}
                      onClick={() => {
                        setEditDraft(null);
                        setArchiveDraft({
                          recordId: observation.id,
                          type: "observation",
                          reason: "",
                        });
                      }}
                      type="button"
                    >
                      <Archive size={15} /> Mark entered in error
                    </button>
                  </div>
                )}
                {editDraft?.recordId === observation.id && (
                  <form className="clinical-edit-form" onSubmit={(event) => void saveClinicalEdit(event)}>
                    <div className="form-grid">
                      <label className="form-field">
                        <span>Observation code</span>
                        <input
                          maxLength={64}
                          onChange={(event) =>
                            setEditDraft((current) =>
                              current ? { ...current, values: { ...current.values, code: event.target.value } } : current,
                            )
                          }
                          required
                          value={editDraft.values.code}
                        />
                      </label>
                      <label className="form-field">
                        <span>Label</span>
                        <input
                          maxLength={160}
                          onChange={(event) =>
                            setEditDraft((current) =>
                              current ? { ...current, values: { ...current.values, label: event.target.value } } : current,
                            )
                          }
                          required
                          value={editDraft.values.label}
                        />
                      </label>
                    </div>
                    <div className="form-grid">
                      <label className="form-field">
                        <span>Value</span>
                        <input
                          maxLength={160}
                          onChange={(event) =>
                            setEditDraft((current) =>
                              current ? { ...current, values: { ...current.values, value: event.target.value } } : current,
                            )
                          }
                          required
                          value={editDraft.values.value}
                        />
                      </label>
                      <label className="form-field">
                        <span>Unit</span>
                        <input
                          maxLength={32}
                          onChange={(event) =>
                            setEditDraft((current) =>
                              current ? { ...current, values: { ...current.values, unit: event.target.value } } : current,
                            )
                          }
                          value={editDraft.values.unit}
                        />
                      </label>
                      <label className="form-field">
                        <span>Recorded at</span>
                        <input
                          onChange={(event) =>
                            setEditDraft((current) =>
                              current ? { ...current, values: { ...current.values, recordedAt: event.target.value } } : current,
                            )
                          }
                          required
                          type="datetime-local"
                          value={editDraft.values.recordedAt}
                        />
                      </label>
                    </div>
                    <div className="form-actions">
                      <button className="button button-primary" disabled={saving} type="submit">
                        <Save size={15} /> Save changes
                      </button>
                      <button className="button button-quiet" onClick={() => setEditDraft(null)} type="button">
                        Cancel
                      </button>
                    </div>
                  </form>
                )}
                {archiveDraft?.recordId === observation.id && (
                  <form className="clinical-edit-form" onSubmit={(event) => void markEnteredInError(event)}>
                    <label className="form-field">
                      <span>Reason for marking entered in error <b>*</b></span>
                      <textarea
                        maxLength={500}
                        minLength={3}
                        onChange={(event) =>
                          setArchiveDraft((current) =>
                            current ? { ...current, reason: event.target.value } : current,
                          )
                        }
                        required
                        rows={2}
                        value={archiveDraft.reason}
                      />
                    </label>
                    <div className="form-actions">
                      <button className="button button-secondary" disabled={saving} type="submit">
                        Confirm entered in error
                      </button>
                      <button className="button button-quiet" onClick={() => setArchiveDraft(null)} type="button">
                        Cancel
                      </button>
                    </div>
                  </form>
                )}
              </article>
            ))}
          </div>
        ) : (
          <p className="detail-muted">No observations stored on this device.</p>
        )}
      </section>

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
