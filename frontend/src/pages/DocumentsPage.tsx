import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Eye, FileText, Paperclip, ShieldCheck, Upload, X } from "lucide-react";
import { PageHeader } from "../components/PageHeader";
import { EmptyState, ErrorState, LoadingState } from "../components/StatePanel";
import { SyncStateBadge } from "../components/SyncStateBadge";
import { documentRepository } from "../repositories/documentRepository";
import { patientRepository } from "../repositories/patientRepository";
import { syncRepository, type RecordSyncState } from "../repositories/syncRepository";
import {
  MAX_DOCUMENT_BYTES,
  SUPPORTED_DOCUMENT_TYPES,
  formatBytes,
  validateDocument,
} from "../offline/storage";
import type { LocalDocument, LocalPatient } from "../database/types";

export function DocumentsPage() {
  const [patients, setPatients] = useState<LocalPatient[]>([]);
  const [documents, setDocuments] = useState<LocalDocument[]>([]);
  const [states, setStates] = useState<Map<string, RecordSyncState>>(new Map());
  const [patientId, setPatientId] = useState("");
  const [description, setDescription] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState<{
    document: LocalDocument;
    url: string;
  } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const [patientPage, localDocuments] = await Promise.all([
        patientRepository.listLocal({ pageSize: 500 }),
        documentRepository.listLocal(),
      ]);
      setPatients(patientPage.items);
      setDocuments(localDocuments);
      setStates(
        await syncRepository.entityStates(localDocuments.map((item) => item.id)),
      );
      setError("");
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Local documents could not be read.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Object URLs are revoked when the preview closes or the page unmounts.
  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview.url);
    };
  }, [preview]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setMessage("");
    if (!file) {
      setError("Choose a file to store on this device.");
      return;
    }
    const problem = validateDocument(file);
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    try {
      const saved = await documentRepository.saveLocal({
        patientId,
        file,
        description: description.trim(),
      });
      setMessage(
        `"${saved.fileName}" is saved securely on this device. Waiting for internet connection to synchronize.`,
      );
      setFile(null);
      setDescription("");
      if (fileInput.current) fileInput.current.value = "";
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "The document could not be stored.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function openPreview(document: LocalDocument) {
    setError("");
    try {
      const blob = await documentRepository.openLocal(document.id);
      if (!blob) {
        setError("The stored bytes for this document could not be found.");
        return;
      }
      if (preview) URL.revokeObjectURL(preview.url);
      setPreview({ document, url: URL.createObjectURL(blob) });
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "The document could not be opened.",
      );
    }
  }

  function closePreview() {
    if (preview) URL.revokeObjectURL(preview.url);
    setPreview(null);
  }

  return (
    <>
      <PageHeader
        eyebrow="CLINICAL DOCUMENTS"
        title="Documents"
        description="Files are encrypted and stored on this device first. The local original is kept until the server confirms the upload."
      />
      {message && (
        <div className="notice notice-success" role="status">
          <ShieldCheck size={17} />
          {message}
        </div>
      )}
      {error && <ErrorState>{error}</ErrorState>}

      <section className="content-card">
        <div className="section-heading">
          <div>
            <h2>Attach a document</h2>
            <p>
              Up to {formatBytes(MAX_DOCUMENT_BYTES)}. Accepted formats:{" "}
              {SUPPORTED_DOCUMENT_TYPES.map((type) => type.split("/")[1].toUpperCase()).join(
                ", ",
              )}
              .
            </p>
          </div>
        </div>
        {loading ? (
          <LoadingState label="Reading local documents..." />
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
                <span>
                  File <b>*</b>
                </span>
                <input
                  accept={SUPPORTED_DOCUMENT_TYPES.join(",")}
                  aria-label="Document file"
                  onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                  ref={fileInput}
                  required
                  type="file"
                />
              </label>
              <label className="form-field">
                <span>Or capture a document with your camera</span>
                <input
                  accept="image/jpeg,image/png,image/webp"
                  aria-label="Camera capture"
                  capture="environment"
                  onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                  type="file"
                />
              </label>
              <label className="form-field form-span-2">
                <span>Description</span>
                <input
                  maxLength={500}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="For example: referral letter, wound photograph"
                  value={description}
                />
              </label>
            </div>
            <div className="form-actions">
              <span className="form-hint">
                Encrypted with AES-GCM and written to this device before any
                network request.
              </span>
              <button className="button button-primary" disabled={saving} type="submit">
                {saving ? (
                  "Storing locally..."
                ) : (
                  <>
                    <Upload size={16} /> Save on this device
                  </>
                )}
              </button>
            </div>
          </form>
        ) : (
          <EmptyState
            title="Register a patient first"
            description="Documents are always linked to a patient record stored in this device's vault."
          />
        )}
      </section>

      <section className="dashboard-section">
        <div className="section-heading">
          <div>
            <h2>Stored on this device</h2>
            <p>{documents.length} document(s)</p>
          </div>
        </div>
        {loading ? (
          <LoadingState />
        ) : documents.length ? (
          <div className="patient-list-card">
            {documents.map((document) => {
              const patient = patients.find((item) => item.id === document.patientId);
              return (
                <article className="patient-row document-row" key={document.id}>
                  <span className="patient-initials">
                    <FileText size={17} />
                  </span>
                  <span className="patient-row-main">
                    <strong>{document.fileName}</strong>
                    <small>
                      {patient?.fullName ?? "Patient unavailable"} ·{" "}
                      {formatBytes(document.byteSize)} · {document.mimeType}
                      {document.description ? ` · ${document.description}` : ""}
                    </small>
                    {document.uploadError && (
                      <small className="operation-error">{document.uploadError}</small>
                    )}
                  </span>
                  <SyncStateBadge state={states.get(document.id) ?? "saved_locally"} />
                  <button
                    className="button button-quiet"
                    onClick={() => void openPreview(document)}
                    type="button"
                  >
                    <Eye size={15} /> Preview
                  </button>
                </article>
              );
            })}
          </div>
        ) : (
          <EmptyState
            title="No documents stored yet"
            description="Attach a scan, photograph or referral letter. It stays on this device until synchronization succeeds."
            action={
              <span className="empty-caption">
                <Paperclip size={14} /> Use the form above
              </span>
            }
          />
        )}
      </section>

      {preview && (
        <div className="document-preview" role="dialog" aria-label="Document preview">
          <div className="document-preview-head">
            <strong>{preview.document.fileName}</strong>
            <button
              aria-label="Close preview"
              className="toast-close"
              onClick={closePreview}
              type="button"
            >
              <X size={16} />
            </button>
          </div>
          {preview.document.mimeType === "application/pdf" ? (
            <object
              aria-label={preview.document.fileName}
              data={preview.url}
              type="application/pdf"
            >
              <p>
                This browser cannot preview PDFs inline.{" "}
                <a href={preview.url} rel="noreferrer" target="_blank">
                  Open the stored copy
                </a>
                .
              </p>
            </object>
          ) : (
            <img alt={preview.document.description || "Stored document"} src={preview.url} />
          )}
        </div>
      )}
    </>
  );
}
