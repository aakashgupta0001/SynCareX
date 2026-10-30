import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  AlertTriangle,
  Check,
  Download,
  FileImage,
  FileText,
  LockKeyhole,
  Mic,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { PageHeader } from "../components/PageHeader";
import { EmptyState, ErrorState, LoadingState } from "../components/StatePanel";
import type { AIArtifactKind } from "../database/types";
import {
  allergyRepository,
  clinicalNoteRepository,
  consultationRepository,
  medicationRepository,
  observationRepository,
} from "../repositories/consultationRepository";
import { aiRepository, type DecryptedAIArtifact } from "../repositories/aiRepository";
import { patientRepository } from "../repositories/patientRepository";
import { rankHistoryLines } from "../offline/historyRanking";
import type { LocalPatient } from "../database/types";
import { localAIClient, type ExtractedFact, type LocalAIModel, type LocalAIStatus } from "../services/localAI";

const AUDIO_TYPES = ["audio/wav", "audio/mpeg", "audio/mp4", "audio/ogg", "audio/webm", "audio/flac"];
const DOCUMENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/tiff",
  "image/webp",
  "application/pdf",
  ".pdf",
];
const CAMERA_IMAGE_TYPES = ["image/*"];

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(0)} MiB`;
}

function kindLabel(kind: AIArtifactKind): string {
  return kind.replaceAll("_", " ");
}

function textFrom(artifact: DecryptedAIArtifact): string {
  return typeof artifact.payload.text === "string" ? artifact.payload.text : "";
}

export function AIWorkspacePage() {
  const [status, setStatus] = useState<LocalAIStatus | null>(null);
  const [models, setModels] = useState<LocalAIModel[]>([]);
  const [artifacts, setArtifacts] = useState<DecryptedAIArtifact[]>([]);
  const [patients, setPatients] = useState<LocalPatient[]>([]);
  const [patientId, setPatientId] = useState("");
  const [historyQuery, setHistoryQuery] = useState("");
  const [selectedArtifact, setSelectedArtifact] = useState<DecryptedAIArtifact | null>(null);
  const [token, setToken] = useState("");
  const [audio, setAudio] = useState<File | null>(null);
  const [documentFile, setDocumentFile] = useState<File | null>(null);
  const [transcriptionModel, setTranscriptionModel] = useState("whisper-tiny");
  const [extractionModel, setExtractionModel] = useState("qwen-0.5b-q4");
  const [language, setLanguage] = useState<"auto" | "en" | "hi">("auto");
  const [speechTask, setSpeechTask] = useState<"transcribe" | "translate">(
    "transcribe",
  );
  const [ocrLanguage, setOcrLanguage] = useState("eng");
  const [sourceText, setSourceText] = useState("");
  const [facts, setFacts] = useState<ExtractedFact[]>([]);
  const [acceptedFacts, setAcceptedFacts] = useState<Set<number>>(new Set());
  const [summary, setSummary] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [recording, setRecording] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [localArtifacts, patientPage] = await Promise.all([
        aiRepository.listLocal(),
        patientRepository.listLocal({ pageSize: 500 }),
      ]);
      setArtifacts(localArtifacts);
      setPatients(patientPage.items);
      const [localStatus, localModels] = await Promise.all([
        localAIClient.status(),
        localAIClient.models(),
      ]);
      setStatus(localStatus);
      setModels(localModels);
    } catch (reason) {
      try {
        setArtifacts(await aiRepository.listLocal());
        setPatients((await patientRepository.listLocal({ pageSize: 500 })).items);
      } catch (storageError) {
        setError(
          storageError instanceof Error
            ? storageError.message
            : "Local AI work could not be read.",
        );
      }
      setStatus(null);
      setModels([]);
      setMessage("");
      setError((current) =>
        current ||
        (reason instanceof Error
          ? reason.message
          : "The local AI engine is unavailable. Local work remains on this device."),
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(
    () => () => {
      if (recorderRef.current?.state === "recording") {
        recorderRef.current.onstop = null;
        recorderRef.current.stop();
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
    },
    [],
  );

  const transcriptionModels = useMemo(
    () => models.filter((model) => model.task === "transcription"),
    [models],
  );
  const extractionModels = useMemo(
    () => models.filter((model) => model.task === "structured-extraction"),
    [models],
  );

  async function install(model: LocalAIModel) {
    setBusy(model.id);
    setError("");
    setMessage("");
    try {
      await localAIClient.installModel(model.id, token);
      setMessage(`${model.name} downloaded and checksum-verified.`);
      await reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Model download failed.");
    } finally {
      setBusy("");
    }
  }

  async function startRecording() {
      setError("");
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
        setError("Audio recording is not supported by this browser. You can still select a saved recording.");
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        streamRef.current = stream;
        const recorder = new MediaRecorder(stream);
        recorderRef.current = recorder;
        const chunks: BlobPart[] = [];
        recorder.ondataavailable = (event) => {
          if (event.data.size) chunks.push(event.data);
        };
        recorder.onerror = () => {
          setError("The browser could not record audio. Try selecting an audio file instead.");
          setRecording(false);
          stream.getTracks().forEach((track) => track.stop());
        };
        recorder.onstop = () => {
          const recordingBlob = new Blob(chunks, {
            type: recorder.mimeType || "audio/webm",
          });
          if (recordingBlob.size) {
            setAudio(
              new File(
                [recordingBlob],
                `voice-note-${new Date().toISOString().replaceAll(":", "-")}.webm`,
                { type: recordingBlob.type },
              ),
            );
          }
          stream.getTracks().forEach((track) => track.stop());
          streamRef.current = null;
          setRecording(false);
        };
        recorder.start();
        setRecording(true);
      } catch (reason) {
        setError(
          reason instanceof Error
            ? `Microphone access failed: ${reason.message}`
            : "Microphone access failed. Check browser permissions.",
        );
      }
    }

    function stopRecording() {
      if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    }

    async function retrievePatientHistory() {
      setError("");
      setMessage("");
      if (!patientId) {
        setError("Select a patient before searching local history.");
        return;
      }
      setBusy("history");
      try {
        const patient = await patientRepository.getLocal(patientId);
        if (!patient) throw new Error("The selected patient is no longer available locally.");
        const [
          consultations,
          notes,
          observations,
          allergies,
          medications,
        ] = await Promise.all([
          consultationRepository.listByPatientLocal(patientId),
          clinicalNoteRepository.listByPatientLocal(patientId),
          observationRepository.listByPatientLocal(patientId),
          allergyRepository.listByPatientLocal(patientId),
          medicationRepository.listByPatientLocal(patientId),
        ]);
        const sourceLines = [
          patient.relevantHistory && `Recorded history: ${patient.relevantHistory}`,
          ...allergies.filter((item) => !item.enteredInErrorAt).map(
            (item) =>
              `Recorded allergy: ${item.substance}; reaction: ${item.reaction}; severity: ${item.severity}`,
          ),
          ...medications.filter((item) => !item.enteredInErrorAt).map(
            (item) =>
              `Recorded medication: ${item.name}; dose: ${item.dose}; frequency: ${item.frequency}`,
          ),
          ...observations.filter((item) => !item.enteredInErrorAt).map(
            (item) => `Recorded observation (${item.recordedAt}): ${item.label} ${item.value} ${item.unit}`,
          ),
          ...notes.map((item) => `Clinical note (${item.noteType}): ${item.body}`),
          ...consultations.map(
            (item) =>
              `Consultation (${item.occurredAt}): ${item.reason}; notes: ${item.notes}`,
          ),
        ].filter((line): line is string => Boolean(line?.trim()));
        const term = historyQuery.trim();
        // Rank before applying the character budget, so the context sent to
        // the model is the most relevant history rather than whichever
        // records happen to come first.
        const ranked = rankHistoryLines(sourceLines, term, 15_000);
        const matches = ranked.lines;
        if (!matches.length) {
          setError(
            term
              ? "No local history matched that text. Try a different keyword or clear the search."
              : "No local history is recorded for this patient yet.",
          );
          return;
        }
        setSourceText(matches.join("\n"));
        setMessage(
          `Loaded ${matches.length} of ${ranked.matched} matching item(s) for ${patient.fullName}, most relevant first.${ranked.truncated ? " Some matches did not fit the 15,000-character budget; narrow the search to include them." : ""} Review and edit the source before sending it to the local AI engine.`,
        );
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "Local patient history could not be read.");
      } finally {
        setBusy("");
      }
    }

  async function submitTranscription(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setMessage("");
    if (!audio) {
      setError("Choose an audio file first.");
      return;
    }

    setBusy("transcription");
    try {
      const source = await aiRepository.saveSource("audio_source", audio);
      const localSource = await aiRepository.openSource(source.id);
      if (!localSource) throw new Error("The encrypted audio copy could not be reopened.");
      const savedFile = new File([localSource.blob], localSource.fileName, {
        type: localSource.blob.type,
      });
      const result = await localAIClient.transcribe(
        savedFile,
        transcriptionModel,
        language,
        token,
        speechTask,
      );
      const transcript = await aiRepository.saveArtifact("transcript", {
        text: result.text,
        language: result.language,
        model_id: result.model_id,
        source_id: source.id,
        task: result.task,
        translated_to: result.translated_to,
      });
      setSelectedArtifact(transcript);
      setSourceText(result.text);
      setMessage(
        result.translated_to
          ? "Audio was translated to English by the local engine. The translation is a machine output and must be reviewed by a clinician; the source and result are encrypted on this device."
          : "Audio was processed by the local engine; the source and transcript are encrypted on this device.",
      );
      await reload();
    } catch (reason) {
      const detail =
        reason instanceof Error ? reason.message : "Transcription failed.";
      await reload();
      setError(
        `${detail} The selected audio was saved locally before processing.`,
      );
    } finally {
      setBusy("");
    }
  }

  async function submitOCR(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setMessage("");
    if (!documentFile) {
      setError("Choose or capture an image or PDF first.");
      return;
    }
    setBusy("ocr");
    try {
      const source = await aiRepository.saveSource("document_source", documentFile);
      const localSource = await aiRepository.openSource(source.id);
      if (!localSource) throw new Error("The encrypted document copy could not be reopened.");
      const savedFile = new File([localSource.blob], localSource.fileName, {
        type: localSource.blob.type,
      });
      const result = await localAIClient.ocr(savedFile, ocrLanguage, token);
      const ocrArtifact = await aiRepository.saveArtifact("ocr_text", {
        text: result.text,
        language: result.language,
        source_id: source.id,
      });
      setSelectedArtifact(ocrArtifact);
      setSourceText(result.text);
      setMessage("Document text was read locally; the original and OCR result are encrypted on this device.");
      await reload();
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : "OCR failed.";
      await reload();
      setError(
        `${detail} The selected document was saved locally before processing.`,
      );
    } finally {
      setBusy("");
    }
  }

  async function submitExtraction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setMessage("");
    if (!sourceText.trim()) {
      setError("Add or load source text before extracting facts.");
      return;
    }
    setBusy("extraction");
    try {
      const source = await aiRepository.saveArtifact("transcript", {
        text: sourceText,
        source_kind: "clinician-provided",
      });
      const result = await localAIClient.extract(sourceText, extractionModel, token);
      const extraction = await aiRepository.saveArtifact(
        "extraction",
        {
          facts: result.facts,
          model_id: result.model_id,
          source_id: source.id,
          review_decisions: [],
        },
        "review_required",
      );
      setSelectedArtifact(extraction);
      setFacts(result.facts);
      setAcceptedFacts(new Set());
      setMessage("Extracted statements are unverified. Review each statement against its quoted source.");
      await reload();
    } catch (reason) {
      const detail =
        reason instanceof Error ? reason.message : "Fact extraction failed.";
      await reload();
      setError(
        `${detail} Source text was encrypted locally before processing.`,
      );
    } finally {
      setBusy("");
    }
  }

  function toggleFact(index: number) {
    setAcceptedFacts((current) => {
      const updated = new Set(current);
      if (updated.has(index)) updated.delete(index);
      else updated.add(index);
      return updated;
    });
  }

  async function saveReview() {
    if (!selectedArtifact || selectedArtifact.kind !== "extraction") return;
    const decisions = facts.map((fact, index) => ({
      ...fact,
      decision: acceptedFacts.has(index) ? "accepted_by_clinician" : "not_accepted",
    }));
    try {
      const updated = await aiRepository.updateLocal(
        selectedArtifact.id,
        { ...selectedArtifact.payload, facts: decisions, reviewed_at: new Date().toISOString() },
        "reviewed",
      );
      setSelectedArtifact(updated);
      setMessage("Review decisions were saved encrypted on this device. No facts were added to a clinical note.");
      await reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Review decisions could not be saved.");
    }
  }

  function createSourceLinkedSummary() {
    if (!facts.length) {
      setError("Review extracted facts before building a source-linked summary.");
      return;
    }
    const selected = facts.filter((_, index) => acceptedFacts.has(index));
    if (!selected.length) {
      setError("Select at least one fact you have reviewed.");
      return;
    }
    setSummary(
      selected
        .map((fact) => `${fact.category}: ${fact.value} — source: “${fact.evidence}”`)
        .join("\n"),
    );
    setError("");
  }

  async function saveSummary() {
    if (!summary.trim()) return;
    try {
      const saved = await aiRepository.saveArtifact("summary", {
        text: summary.trim(),
        source_id: selectedArtifact?.id ?? null,
        clinician_edited: true,
      });
      setSelectedArtifact(saved);
      setMessage("Editable source-linked summary saved encrypted on this device.");
      await reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Summary could not be saved.");
    }
  }

  async function openArtifact(artifact: DecryptedAIArtifact) {
    setSelectedArtifact(artifact);
    const text = textFrom(artifact);
    if (text) setSourceText(text);
    if (artifact.kind === "extraction" && Array.isArray(artifact.payload.facts)) {
      const storedFacts = artifact.payload.facts as Array<ExtractedFact & { decision?: string }>;
      setFacts(storedFacts);
      setAcceptedFacts(
        new Set(
          storedFacts.flatMap((fact, index) =>
            fact.decision === "accepted_by_clinician" ? [index] : [],
          ),
        ),
      );
    } else {
      setFacts([]);
      setAcceptedFacts(new Set());
    }
    if (artifact.kind === "summary" && text) setSummary(text);
  }

  const runtimeNames = status
    ? Object.entries(status.runtimes)
        .map(([name, runtime]) => `${name}: ${runtime.available ? "ready" : "not installed"}`)
        .join(" · ")
    : "Engine not connected";

  return (
    <>
      <PageHeader
        eyebrow="OPTIONAL · LOCAL PROCESSING"
        title="AI workspace"
        description="Local transcription, OCR and evidence-linked extraction. Source files are encrypted on this device before they are sent to the loopback AI engine."
        action={
          <button className="button button-quiet" onClick={() => void reload()} type="button">
            <RefreshCw size={15} /> Refresh readiness
          </button>
        }
      />

      <div className="notice notice-warn">
        <AlertTriangle size={17} />
        <span>
          AI output is unverified documentation assistance, not diagnosis or treatment advice.
          A qualified clinician must review it. No model is downloaded automatically.
        </span>
      </div>
      {message && (
        <div className="notice notice-success" role="status">
          <Check size={17} /> {message}
        </div>
      )}
      {error && <ErrorState>{error}</ErrorState>}

      <section className="ai-readiness-grid" aria-label="Local AI readiness">
        <article className="content-card ai-readiness-card">
          <span className="stat-icon stat-icon-teal"><ShieldCheck size={18} /></span>
          <h2>Engine status</h2>
          <strong>{status?.ready ? "Configured" : "Not connected"}</strong>
          <p>{runtimeNames}</p>
        </article>
        <article className="content-card ai-readiness-card">
          <span className="stat-icon stat-icon-blue"><Sparkles size={18} /></span>
          <h2>Available memory</h2>
          <strong>{status ? `${formatBytes(status.available_ram_mb * 1024 * 1024)} free` : "—"}</strong>
          <p>
            {status
              ? `${formatBytes(status.total_ram_mb * 1024 * 1024)} total · ${formatBytes(status.free_disk_mb * 1024 * 1024)} free disk · ${status.logical_cores} CPU threads`
              : "Start the local engine to check device capacity."}
          </p>
          {status && (
            <p>
              {status.processor} · {status.operating_system}. {status.accelerator_note}
            </p>
          )}
        </article>
        <article className="content-card ai-readiness-card">
          <span className="stat-icon stat-icon-amber"><LockKeyhole size={18} /></span>
          <h2>Local engine token</h2>
          <label className="ai-token-field">
            <span className="sr-only">Local AI engine token</span>
            <input
              autoComplete="off"
              onChange={(event) => setToken(event.target.value)}
              placeholder="Paste token from local engine setup"
              type="password"
              value={token}
            />
          </label>
          <p>Held in page memory only; it is not saved in browser storage.</p>
        </article>
      </section>

      <section className="content-card ai-models">
        <div className="section-heading">
          <div>
            <h2>Model manager</h2>
            <p>Downloads are user-triggered, size-limited, and SHA-256 verified before installation.</p>
          </div>
        </div>
        {loading ? (
          <LoadingState label="Checking local runtimes and model catalog..." />
        ) : models.length ? (
          <div className="ai-model-list">
            {models.map((model) => (
              <article className="ai-model-row" key={model.id}>
                <div className="ai-model-info">
                  <strong>{model.name}</strong>
                  <span>
                    {formatBytes(model.size_bytes)} · {model.runtime} · {model.license} ·
                    {" "}requires {formatBytes(model.minimum_free_ram_mb * 1024 * 1024)} free RAM
                  </span>
                  {model.availability_reason && (
                    <small>{model.availability_reason}</small>
                  )}
                </div>
                {model.installed ? (
                  <span className={`ai-installed ${model.compatible_now ? "ai-ready" : ""}`}>
                    {model.compatible_now ? "Ready" : "Installed"}
                  </span>
                ) : (
                  <button
                    className="button button-secondary"
                    disabled={
                      !token ||
                      busy === model.id ||
                      (status !== null &&
                        status.free_disk_mb * 1024 * 1024 < model.size_bytes + 16 * 1024 * 1024)
                    }
                    onClick={() => void install(model)}
                    type="button"
                  >
                    <Download size={15} />
                    {busy === model.id ? "Downloading..." : `Download ${formatBytes(model.size_bytes)}`}
                  </button>
                )}
              </article>
            ))}
          </div>
        ) : (
          <EmptyState
            title="Local AI engine unavailable"
            description="Start the loopback service to inspect compatible models. The rest of the clinical workspace continues to work without it."
          />
        )}
      </section>

      <div className="ai-tool-grid">
        <section className="content-card">
          <div className="section-heading">
            <div>
              <h2><Mic size={17} /> Voice transcription</h2>
              <p>Audio is stored encrypted before local processing. Hindi and English use explicit language selection; mixed Hindi-English (Hinglish) uses automatic detection and has not been accuracy-validated.</p>
            </div>
          </div>
          <form className="ai-form" onSubmit={(event) => void submitTranscription(event)}>
            <div className="ai-record-controls">
              {recording ? (
                <button className="button button-secondary" onClick={stopRecording} type="button">
                  Stop recording
                </button>
              ) : (
                <button className="button button-secondary" onClick={() => void startRecording()} type="button">
                  <Mic size={15} /> Record voice note
                </button>
              )}
              {recording && <span role="status">Recording in this browser…</span>}
            </div>
            <label className="form-field">
              <span>Audio recording</span>
              <input
                accept={AUDIO_TYPES.join(",")}
                onChange={(event) => setAudio(event.target.files?.[0] ?? null)}
                type="file"
              />
            </label>
            <div className="ai-form-row">
              <label className="form-field">
                <span>Model</span>
                <select
                  onChange={(event) => setTranscriptionModel(event.target.value)}
                  value={transcriptionModel}
                >
                  {transcriptionModels.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name}{model.installed ? "" : " · not installed"}
                    </option>
                  ))}
                </select>
              </label>
              <label className="form-field">
                <span>Language</span>
                <select
                  onChange={(event) => setLanguage(event.target.value as "auto" | "en" | "hi")}
                  value={language}
                >
                  <option value="auto">Auto-detect (including mixed Hindi-English)</option>
                  <option value="hi">Hindi</option>
                  <option value="en">English</option>
                </select>
              </label>
              <label className="form-field">
                <span>Output</span>
                <select
                  onChange={(event) =>
                    setSpeechTask(
                      event.target.value as "transcribe" | "translate",
                    )
                  }
                  value={speechTask}
                >
                  <option value="transcribe">
                    Transcribe in the spoken language
                  </option>
                  <option value="translate">Translate to English</option>
                </select>
              </label>
            </div>
            <button className="button button-primary" disabled={busy !== ""} type="submit">
              {busy === "transcription"
                ? speechTask === "translate"
                  ? "Translating locally..."
                  : "Transcribing locally..."
                : speechTask === "translate"
                  ? "Save locally & translate"
                  : "Save locally & transcribe"}
            </button>
          </form>
        </section>

        <section className="content-card">
          <div className="section-heading">
            <div>
              <h2><FileImage size={17} /> Document OCR</h2>
              <p>
                Printed text is best supported. Handwriting recognition is experimental and may be inaccurate;
                verify every result against the original. PDFs are limited to 10 pages and need Poppler.
              </p>
            </div>
          </div>
          <form className="ai-form" onSubmit={(event) => void submitOCR(event)}>
            <label className="form-field">
              <span>Choose an image or PDF</span>
              <input
                accept={DOCUMENT_TYPES.join(",")}
                onChange={(event) => setDocumentFile(event.target.files?.[0] ?? null)}
                type="file"
              />
            </label>
            <label className="form-field">
              <span>Or capture a document with your camera</span>
              <input
                accept={CAMERA_IMAGE_TYPES.join(",")}
                capture="environment"
                onChange={(event) => setDocumentFile(event.target.files?.[0] ?? null)}
                type="file"
              />
            </label>
            <label className="form-field">
              <span>Tesseract language code(s)</span>
              <input
                maxLength={15}
                onChange={(event) => setOcrLanguage(event.target.value)}
                placeholder="eng or eng+hin"
                value={ocrLanguage}
              />
            </label>
            <button className="button button-primary" disabled={busy !== ""} type="submit">
              {busy === "ocr" ? "Reading locally..." : "Save locally & read text"}
            </button>
          </form>
        </section>
      </div>

      <section className="content-card ai-history-search">
        <div className="section-heading">
          <div>
            <h2>Local patient-history retrieval</h2>
            <p>Searches only records already decrypted from this device’s IndexedDB vault. Nothing is sent until you explicitly submit extraction.</p>
          </div>
        </div>
        {patients.length ? (
          <div className="ai-history-controls">
            <label className="form-field">
              <span>Local patient</span>
              <select onChange={(event) => setPatientId(event.target.value)} value={patientId}>
                <option value="">Select a patient</option>
                {patients.map((patient) => (
                  <option key={patient.id} value={patient.id}>
                    {patient.fullName} · {patient.patientNumber}
                  </option>
                ))}
              </select>
            </label>
            <label className="form-field">
              <span>Optional text search</span>
              <input
                onChange={(event) => setHistoryQuery(event.target.value)}
                placeholder="Filter local history by exact words"
                value={historyQuery}
              />
            </label>
            <button
              className="button button-secondary"
              disabled={busy !== ""}
              onClick={() => void retrievePatientHistory()}
              type="button"
            >
              {busy === "history" ? "Searching local records…" : "Load matching history"}
            </button>
          </div>
        ) : (
          <EmptyState title="No local patients" description="Patient history retrieval is available after records have been saved on this device." />
        )}
      </section>

      <section className="content-card ai-extraction">
        <div className="section-heading">
          <div>
            <h2><Sparkles size={17} /> Evidence-linked extraction & review</h2>
            <p>Paste a transcript or OCR result. The selected source is encrypted locally before extraction; only the loopback service receives it.</p>
          </div>
        </div>
        <form className="ai-form" onSubmit={(event) => void submitExtraction(event)}>
          <label className="form-field">
            <span>Source text</span>
            <textarea
              maxLength={15_000}
              onChange={(event) => setSourceText(event.target.value)}
              placeholder="Paste a transcript, OCR result, or clinician-recorded text. Avoid adding information not present in the source."
              rows={5}
              value={sourceText}
            />
          </label>
          <div className="ai-extraction-actions">
            <label className="form-field">
              <span>Local extraction model</span>
              <select
                onChange={(event) => setExtractionModel(event.target.value)}
                value={extractionModel}
              >
                {extractionModels.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}{model.installed ? "" : " · not installed"}
                  </option>
                ))}
              </select>
            </label>
            <button className="button button-primary" disabled={busy !== ""} type="submit">
              {busy === "extraction" ? "Extracting locally..." : "Extract facts for review"}
            </button>
          </div>
        </form>
        {facts.length > 0 && (
          <div className="ai-review-list">
            <div className="ai-review-heading">
              <strong>Clinician review required</strong>
              <span>{facts.length} source-linked statement(s)</span>
            </div>
            {facts.map((fact, index) => (
              <label className="ai-fact" key={`${fact.category}:${fact.evidence}:${index}`}>
                <input
                  checked={acceptedFacts.has(index)}
                  onChange={() => toggleFact(index)}
                  type="checkbox"
                />
                <span className="ai-fact-copy">
                  <strong>{fact.category}: {fact.value}</strong>
                  <q>{fact.evidence}</q>
                  <small>Model confidence {(fact.confidence * 100).toFixed(0)}% · verify against original source</small>
                </span>
              </label>
            ))}
            <div className="form-actions">
              <button className="button button-secondary" onClick={() => void saveReview()} type="button">
                Save review decisions
              </button>
              <button className="button button-quiet" onClick={createSourceLinkedSummary} type="button">
                <FileText size={15} /> Build editable source-linked summary
              </button>
            </div>
            <label className="form-field ai-summary-field">
              <span>Editable summary draft</span>
              <textarea
                onChange={(event) => setSummary(event.target.value)}
                placeholder="Select reviewed facts to build a draft, then edit it before saving."
                rows={4}
                value={summary}
              />
            </label>
            <button className="button button-primary" onClick={() => void saveSummary()} type="button">
              Save summary locally
            </button>
          </div>
        )}
      </section>

      <section className="content-card ai-history">
        <div className="section-heading">
          <div>
            <h2>Encrypted local work</h2>
            <p>AI source files and outputs are local-only artifacts; they are not added to the patient sync queue or clinical record automatically.</p>
          </div>
        </div>
        {loading ? (
          <LoadingState label="Loading encrypted AI artifacts..." />
        ) : artifacts.length ? (
          <div className="ai-artifact-list">
            {artifacts.map((artifact) => (
              <button
                className={`ai-artifact-row${selectedArtifact?.id === artifact.id ? " ai-artifact-active" : ""}`}
                key={artifact.id}
                onClick={() => void openArtifact(artifact)}
                type="button"
              >
                <span className="ai-artifact-icon"><FileText size={16} /></span>
                <span>
                  <strong>{kindLabel(artifact.kind)}</strong>
                  <small>{new Date(artifact.updatedAt).toLocaleString()}</small>
                </span>
                <span className={`ai-artifact-status ai-status-${artifact.status}`}>
                  {artifact.status.replaceAll("_", " ")}
                </span>
                {typeof artifact.payload.text === "string" && (
                  <span className="ai-artifact-preview">{artifact.payload.text.slice(0, 100)}</span>
                )}
              </button>
            ))}
          </div>
        ) : (
          <EmptyState title="No local AI work yet" description="Saved audio, OCR and review artifacts will appear here." />
        )}
      </section>
      <p className="ai-runtime-footnote">
        <ShieldCheck size={14} /> {status ? `Models directory: ${status.model_directory}` : "The local AI service is optional; patient care workflows are not blocked by its absence."}
      </p>
    </>
  );
}
