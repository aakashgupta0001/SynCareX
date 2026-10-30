import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ArrowLeft, FileText, NotebookPen, Paperclip, Save } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { EmptyState, ErrorState, LoadingState } from "../components/StatePanel";
import { LocalSaveNotice, SyncStateBadge } from "../components/SyncStateBadge";
import {
  clinicalNoteRepository,
  consultationRepository,
} from "../repositories/consultationRepository";
import { documentRepository } from "../repositories/documentRepository";
import { patientRepository } from "../repositories/patientRepository";
import { syncRepository, type RecordSyncState } from "../repositories/syncRepository";
import { SUPPORTED_DOCUMENT_TYPES, formatBytes, validateDocument } from "../offline/storage";
import type {
  LocalClinicalNote,
  LocalConsultation,
  LocalDocument,
  LocalPatient,
} from "../database/types";

const noteTypes: LocalClinicalNote["noteType"][] = [
  "general",
  "subjective",
  "objective",
  "assessment",
  "plan",
];

export function ConsultationDetailPage() {
  const { consultationId = "" } = useParams();
  const [consultation, setConsultation] = useState<LocalConsultation | null>(null);
  const [patient, setPatient] = useState<LocalPatient | null>(null);
  const [notes, setNotes] = useState<LocalClinicalNote[]>([]);
  const [documents, setDocuments] = useState<LocalDocument[]>([]);
  const [state, setState] = useState<RecordSyncState>("saved_locally");
  const [noteBody, setNoteBody] = useState("");
  const [noteType, setNoteType] = useState<LocalClinicalNote["noteType"]>("general");
  const [summary, setSummary] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    try {
      const record = await consultationRepository.getLocal(consultationId);
      if (!record) {
        setError("This consultation is not stored on this device.");
        return;
      }
      setConsultation(record);
      setSummary(record.notes);
      const [patientRecord, noteList, documentList, recordState] = await Promise.all([
        patientRepository.getLocal(record.patientId),
        clinicalNoteRepository.listByConsultationLocal(record.id),
        documentRepository.listByPatientLocal(record.patientId),
        syncRepository.entityState(record.id),
      ]);
      setPatient(patientRecord);
      setNotes(noteList);
      setDocuments(documentList.filter((item) => item.consultationId === record.id));
      setState(recordState);
      setError("");
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The consultation could not be opened.",
      );
    } finally {
      setLoading(false);
    }
  }, [consultationId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function addNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!consultation) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      await clinicalNoteRepository.createLocal({
        consultationId: consultation.id,
        patientId: consultation.patientId,
        body: noteBody.trim(),
        noteType,
      });
      setNoteBody("");
      setMessage(
        "Note saved securely on this device. Waiting for internet connection to synchronize.",
      );
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "The note could not be saved.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function saveSummary() {
    if (!consultation) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      await consultationRepository.updateLocal(consultation.id, { notes: summary });
      setMessage(
        "Consultation updated on this device. Waiting for internet connection to synchronize.",
      );
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The consultation could not be updated.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function attach(file: File) {
    if (!consultation) return;
    const problem = validateDocument(file);
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError("");
    try {
      await documentRepository.saveLocal({
        patientId: consultation.patientId,
        consultationId: consultation.id,
        file,
      });
      setMessage(
        `"${file.name}" is stored on this device and queued for upload.`,
      );
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "The document could not be stored.",
      );
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <LoadingState label="Opening consultation..." />;
  if (error && !consultation) return <ErrorState>{error}</ErrorState>;
  if (!consultation) return <ErrorState>Consultation unavailable.</ErrorState>;

  return (
    <>
      <Link className="back-link" to="/consultations">
        <ArrowLeft size={16} /> All consultations
      </Link>
      <PageHeader
        eyebrow="CONSULTATION"
        title={patient?.fullName ?? "Patient unavailable"}
        description={`${consultation.reason || "No reason recorded"} · ${new Date(consultation.occurredAt).toLocaleString()}`}
        action={<SyncStateBadge state={state} />}
      />
      <LocalSaveNotice state={state} />
      {message && (
        <div className="notice notice-success" role="status">
          {message}
        </div>
      )}
      {error && <ErrorState>{error}</ErrorState>}

      <div className="profile-columns">
        <section className="content-card">
          <div className="section-heading">
            <div>
              <h2>Consultation summary</h2>
              <p>Edit the summary; each edit is versioned and queued.</p>
            </div>
          </div>
          <label className="form-field consultation-notes">
            <span>Summary notes</span>
            <textarea
              maxLength={20000}
              onChange={(event) => setSummary(event.target.value)}
              rows={7}
              value={summary}
            />
          </label>
          <div className="form-actions">
            <span className="form-hint">Version {consultation.version}</span>
            <button
              className="button button-primary"
              disabled={saving || summary === consultation.notes}
              onClick={() => void saveSummary()}
              type="button"
            >
              <Save size={16} /> Save on this device
            </button>
          </div>
        </section>

        <section className="content-card">
          <div className="section-heading">
            <div>
              <h2>Attached documents</h2>
              <p>{documents.length} stored for this consultation</p>
            </div>
          </div>
          <label className="form-field">
            <span>Attach a file</span>
            <input
              accept={SUPPORTED_DOCUMENT_TYPES.join(",")}
              aria-label="Attach document"
              disabled={saving}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void attach(file);
                event.target.value = "";
              }}
              type="file"
            />
          </label>
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
            <p className="detail-muted">
              <Paperclip size={14} /> No documents attached yet.
            </p>
          )}
        </section>
      </div>

      <section className="content-card">
        <div className="section-heading">
          <div>
            <h2>Clinical notes</h2>
            <p>
              Notes are kept in full; editing creates a new version rather than
              replacing the record.
            </p>
          </div>
        </div>
        {notes.length ? (
          <div className="note-list">
            {notes.map((note) => (
              <article className="note-entry" key={note.id}>
                <span className={`note-type note-type-${note.noteType}`}>
                  {note.noteType}
                </span>
                <p>{note.body}</p>
                <small>
                  v{note.version} · {new Date(note.createdAt).toLocaleString()}
                </small>
              </article>
            ))}
          </div>
        ) : (
          <EmptyState
            title="No notes recorded yet"
            description="Add the first clinician-authored note for this consultation."
          />
        )}

        <form onSubmit={(event) => void addNote(event)}>
          <div className="form-grid">
            <label className="form-field">
              <span>Note type</span>
              <select
                onChange={(event) =>
                  setNoteType(event.target.value as LocalClinicalNote["noteType"])
                }
                value={noteType}
              >
                {noteTypes.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="form-field consultation-notes">
            <span>
              New note <b>*</b>
            </span>
            <textarea
              maxLength={20000}
              onChange={(event) => setNoteBody(event.target.value)}
              placeholder="Clinician-authored documentation only."
              required
              rows={4}
              value={noteBody}
            />
          </label>
          <div className="form-actions">
            <span className="form-hint">
              Saved on this device first, then queued for the server.
            </span>
            <button className="button button-primary" disabled={saving} type="submit">
              <NotebookPen size={16} /> Add note
            </button>
          </div>
        </form>
      </section>
    </>
  );
}
