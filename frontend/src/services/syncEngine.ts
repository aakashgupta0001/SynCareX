import {
  ApiError,
  api,
  mapPatientChangesToApi,
  mapPatientFromApi,
  type PatientResponse,
  type SyncOperationRequest,
  type SyncOperationResult,
} from "./api";
import {
  isApiUsable,
  onApiReconnected,
  probeApi,
  recordSuccessfulSync,
} from "./connectivity";
import { syncRepository } from "../repositories/syncRepository";
import { conflictRepository } from "../repositories/conflictRepository";
import { documentRepository } from "../repositories/documentRepository";
import { patientRepository } from "../repositories/patientRepository";
import { auditRepository } from "../repositories/auditRepository";
import { syncPullRepository } from "../repositories/syncPullRepository";
import { getLocalDeviceId, markDeviceAuthorized, recordServerContact } from "../offline/device";
import { decryptLocalValue, isVaultUnlocked } from "../security/localVault";
import { sealForServer, serverIndexTerms } from "../security/clinicKey";
import { patientTrigrams } from "../offline/searchIndex";
import type { LocalPatient } from "../database/types";
import type { SyncOperation } from "../database/types";

export const SYNC_BATCH_SIZE = 25;

export interface SyncProgress {
  phase: "idle" | "checking" | "sending" | "uploading" | "done" | "skipped";
  total: number;
  completed: number;
  message: string;
}

export interface SyncOutcome {
  attempted: number;
  acknowledged: number;
  conflicts: number;
  failed: number;
  documentsUploaded: number;
  /** True when nothing was attempted because the API was unreachable. */
  skipped: boolean;
  message: string;
}

export type ProgressHandler = (progress: SyncProgress) => void;

let inFlight: Promise<SyncOutcome> | null = null;

/**
 * Converts a queued operation into the wire format. Payloads are decrypted
 * only here, in memory, immediately before the request.
 */
async function toRequest(operation: SyncOperation): Promise<SyncOperationRequest> {
  const payload = await decryptLocalValue<Record<string, unknown>>(operation.payload);
  // Dual-write. Both are omitted when no clinic key is loaded, which keeps a
  // device without one working exactly as before.
  const sealed =
    operation.entityType === "patient" ? await sealForServer(payload) : null;
  const terms =
    operation.entityType === "patient" && sealed
      ? await serverIndexTerms(patientTrigrams(payload as unknown as LocalPatient))
      : [];
  return {
    operation_id: operation.operationId,
    idempotency_key: operation.idempotencyKey,
    actor_id: operation.actorId,
    device_id: operation.deviceId,
    schema_version: 1,
    entity_type: operation.entityType,
    entity_id: operation.entityId,
    operation_type: operation.operationType,
    base_version: operation.baseVersion,
    local_version: operation.localVersion,
    payload: serializePayload(operation, payload),
    ...(sealed
      ? {
          sealed_content: {
            ciphertext: sealed.ciphertext,
            iv: sealed.iv,
            key_epoch: sealed.keyEpoch,
          },
        }
      : {}),
    ...(terms.length ? { search_terms: terms } : {}),
    created_at: operation.createdAt,
  };
}

/**
 * The local model uses camelCase; the API uses snake_case. Patient payloads
 * need field mapping, and the rest are already sent in the server's shape.
 */
function serializePayload(
  operation: SyncOperation,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (operation.entityType === "patient") {
    if (operation.operationType === "create") {
      const patient = payload as Record<string, unknown>;
      return {
        full_name: patient.fullName,
        date_of_birth: patient.dateOfBirth ?? null,
        estimated_age: patient.estimatedAge ?? null,
        gender: patient.gender || null,
        contact_phone: patient.contactPhone || null,
        address: patient.address || null,
        village: patient.village || null,
        emergency_contact_name: patient.emergencyContactName || null,
        emergency_contact_phone: patient.emergencyContactPhone || null,
        relevant_history: patient.relevantHistory || null,
        allergies: patient.allergies ?? [],
      };
    }
    return {
      ...mapPatientChangesToApi(payload),
      expected_version: operation.baseVersion,
    };
  }
  if (operation.entityType === "consultation") {
    return {
      patient_id: payload.patientId ?? payload.patient_id,
      reason: payload.reason ?? null,
      notes: payload.notes ?? null,
      occurred_at: payload.occurredAt ?? payload.occurred_at ?? null,
      status: payload.status ?? "draft",
      ...(operation.operationType === "update"
        ? { expected_version: operation.baseVersion }
        : {}),
    };
  }
  if (operation.entityType === "clinicalNote") {
    return {
      patient_id: payload.patientId ?? payload.patient_id,
      consultation_id: payload.consultationId ?? payload.consultation_id,
      body: payload.body,
      note_type: payload.noteType ?? payload.note_type ?? "general",
      ...(operation.operationType === "update"
        ? { expected_version: operation.baseVersion }
        : {}),
    };
  }
  if (operation.entityType === "patientIdentifier") {
    return {
      patient_id: payload.patientId ?? payload.patient_id,
      system: payload.system,
      value: payload.value,
    };
  }
  if (operation.entityType === "observation") {
    return {
      patient_id: payload.patientId ?? payload.patient_id,
      consultation_id: payload.consultationId ?? payload.consultation_id ?? null,
      code: payload.code,
      label: payload.label,
      value: payload.value,
      unit: payload.unit || null,
      recorded_at: payload.recordedAt ?? payload.recorded_at ?? null,
    };
  }
  if (operation.entityType === "allergy") {
    return {
      patient_id: payload.patientId ?? payload.patient_id,
      substance: payload.substance,
      reaction: payload.reaction || null,
      severity: payload.severity ?? "unknown",
    };
  }
  if (operation.entityType === "medication") {
    return {
      patient_id: payload.patientId ?? payload.patient_id,
      consultation_id: payload.consultationId ?? payload.consultation_id ?? null,
      name: payload.name,
      dose: payload.dose || null,
      frequency: payload.frequency || null,
      started_at: payload.startedAt ?? payload.started_at ?? null,
    };
  }
  // Documents already carry a snake_case payload from the repository.
  return payload;
}

async function applyResult(
  operation: SyncOperation,
  result: SyncOperationResult,
): Promise<"acknowledged" | "conflict" | "failed"> {
  if (result.status === "acknowledged") {
    await syncRepository.markAcknowledged(operation.operationId);
    if (operation.entityType === "patient" && result.entity) {
      await patientRepository.cacheServerPatient(
        mapPatientFromApi(result.entity as unknown as PatientResponse),
      );
    }
    return "acknowledged";
  }
  if (result.status === "conflict") {
    await syncRepository.markConflict(
      operation.operationId,
      result.message ?? "The server holds a newer version of this record.",
    );
    await conflictRepository.record({
      operation,
      serverVersion: result.server_version,
      serverPayload: result.entity,
      message: result.message ?? "Concurrent change detected.",
    });
    return "conflict";
  }
  const message = result.retryable
    ? (result.message ?? "The server could not apply this operation yet.")
    : `${result.message ?? "The server rejected this operation."} A clinician must review it before retrying.`;
  if (result.retryable) {
    await syncRepository.markRetryWait(operation.operationId, message);
  } else {
    await syncRepository.markFailed(operation.operationId, message);
  }
  return "failed";
}

/** Uploads bytes for documents whose metadata the server has accepted. */
async function uploadAcknowledgedDocuments(
  documentIds: string[],
  onProgress?: ProgressHandler,
): Promise<number> {
  let uploaded = 0;
  for (const [index, documentId] of documentIds.entries()) {
    const metadata = await documentRepository.getLocal(documentId);
    if (!metadata || metadata.uploadStatus === "uploaded") continue;
    onProgress?.({
      phase: "uploading",
      total: documentIds.length,
      completed: index,
      message: `Uploading document ${index + 1} of ${documentIds.length}`,
    });
    try {
      await documentRepository.setUploadStatus(documentId, "uploading");
      const bytes = await documentRepository.readBytes(documentId);
      if (!bytes) {
        await documentRepository.setUploadStatus(
          documentId,
          "failed",
          "The encrypted document bytes are missing on this device.",
        );
        continue;
      }
      await api.uploadDocumentContent(
        documentId,
        metadata.fileName,
        metadata.mimeType,
        bytes,
      );
      // The local original is kept; only the status changes.
      await documentRepository.setUploadStatus(documentId, "uploaded");
      uploaded += 1;
    } catch (error) {
      await documentRepository.setUploadStatus(
        documentId,
        "failed",
        error instanceof Error ? error.message : "The document upload failed.",
      );
    }
  }
  return uploaded;
}

async function uploadQueuedDocuments(
  ownerId: string,
  onProgress?: ProgressHandler,
): Promise<number> {
  const [documents, operations] = await Promise.all([
    documentRepository.listLocal(),
    syncRepository.list(ownerId),
  ]);
  const acknowledgedIds = new Set(
    operations
      .filter(
        (operation) =>
          operation.entityType === "document" &&
          operation.status === "acknowledged",
      )
      .map((operation) => operation.entityId),
  );
  const ids = documents
    .filter(
      (document) =>
        document.uploadStatus !== "uploaded" && acknowledgedIds.has(document.id),
    )
    .map((document) => document.id);
  return uploadAcknowledgedDocuments(ids, onProgress);
}

async function downloadMissingDocumentContent(): Promise<number> {
  let downloaded = 0;
  for (const metadata of await documentRepository.listLocal()) {
    if (!metadata.uploadedAt || (await documentRepository.hasLocalBytes(metadata.id))) {
      continue;
    }
    try {
      const bytes = await api.downloadDocumentContent(metadata.id);
      await documentRepository.cacheServerContent(metadata.id, bytes);
      downloaded += 1;
    } catch (error) {
      await documentRepository.setUploadStatus(
        metadata.id,
        "failed",
        error instanceof Error
          ? error.message
          : "The synchronized document could not be downloaded.",
      );
    }
  }
  return downloaded;
}

/**
 * Foreground synchronization. Local records are already durable before this
 * runs; nothing here can lose or delete queued work.
 */
export async function syncNow(
  ownerId: string,
  onProgress?: ProgressHandler,
): Promise<SyncOutcome> {
  if (inFlight) return inFlight;
  inFlight = runSync(ownerId, onProgress).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runSync(
  ownerId: string,
  onProgress?: ProgressHandler,
): Promise<SyncOutcome> {
  const idle: SyncOutcome = {
    attempted: 0,
    acknowledged: 0,
    conflicts: 0,
    failed: 0,
    documentsUploaded: 0,
    skipped: true,
    message: "",
  };

  if (!isVaultUnlocked()) {
    return {
      ...idle,
      message: "Unlock the local vault before synchronizing.",
    };
  }

  onProgress?.({
    phase: "checking",
    total: 0,
    completed: 0,
    message: "Checking whether the SynCareX API is reachable",
  });
  const reachable = (await probeApi()) && isApiUsable();
  if (!reachable) {
    return {
      ...idle,
      message:
        "The SynCareX API is not reachable. Every queued record stays saved on this device.",
    };
  }

  const deviceId = await getLocalDeviceId();
  try {
    let provisioned;
    try {
      provisioned = await api.provisionDevice(deviceId, deviceLabel());
    } catch (error) {
      // A device that has been working offline holds no access token. The
      // refresh session from the last online sign-in can restore one; if it
      // cannot, the clinician must sign in again before anything is sent.
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
      const restored = await api.restoreSession();
      if (!restored) {
        return {
          ...idle,
          message:
            "This device's server session has expired. Sign in again while connected to synchronize. Queued records stay on this device.",
        };
      }
      provisioned = await api.provisionDevice(deviceId, deviceLabel());
    }
    await markDeviceAuthorized({
      serverDeviceId: provisioned.server_device_id,
      actorId: ownerId,
      offlineGraceDays: provisioned.offline_grace_days,
    });
  } catch (error) {
    const message =
      error instanceof ApiError
        ? error.message
        : "This device could not be authorized for synchronization.";
    return { ...idle, message };
  }
  await recordServerContact();

  const due = await syncRepository.getDue(ownerId);
  if (!due.length) {
    const pulled = await pullChanges(ownerId, deviceId);
    const uploaded = await uploadQueuedDocuments(ownerId, onProgress);
    const downloaded = await downloadMissingDocumentContent();
    await recordSuccessfulSync();
    return {
      ...idle,
      skipped: false,
      conflicts: pulled.conflicts,
      message: pulled.applied || pulled.conflicts || downloaded || uploaded
        ? `Applied ${pulled.applied} server change(s), uploaded ${uploaded} document(s), downloaded ${downloaded} document(s); ${pulled.conflicts} conflict(s) need clinician review.`
        : "Nothing is waiting to synchronize.",
    };
  }

  let acknowledged = 0;
  let conflicts = 0;
  let failed = 0;
  let attempted = 0;

  for (let offset = 0; offset < due.length; offset += SYNC_BATCH_SIZE) {
    const batch = due.slice(offset, offset + SYNC_BATCH_SIZE);
    onProgress?.({
      phase: "sending",
      total: due.length,
      completed: offset,
      message: `Sending ${offset + 1}-${offset + batch.length} of ${due.length} queued operations`,
    });

    const requests: SyncOperationRequest[] = [];
    const sent: SyncOperation[] = [];
    for (const operation of batch) {
      try {
        requests.push(await toRequest(operation));
        sent.push(operation);
        await syncRepository.markProcessing(operation.operationId);
      } catch (error) {
        await syncRepository.markFailed(
          operation.operationId,
          error instanceof Error
            ? `This operation could not be prepared: ${error.message}`
            : "This operation could not be prepared for synchronization.",
        );
        failed += 1;
      }
    }
    if (!requests.length) continue;
    attempted += requests.length;

    let response;
    try {
      response = await api.syncOperations(deviceId, requests);
    } catch (error) {
      // The whole batch is unresolved: every operation stays queued.
      const message =
        error instanceof Error
          ? error.message
          : "The synchronization request failed.";
      for (const operation of sent) {
        await syncRepository.markRetryWait(operation.operationId, message);
        failed += 1;
      }
      continue;
    }

    const byKey = new Map(sent.map((operation) => [operation.idempotencyKey, operation]));
    const answered = new Set<string>();
    for (const result of response.results) {
      const operation = byKey.get(result.idempotency_key);
      if (!operation) continue;
      answered.add(result.idempotency_key);
      const outcome = await applyResult(operation, result);
      if (outcome === "acknowledged") {
        acknowledged += 1;
      } else if (outcome === "conflict") {
        conflicts += 1;
      } else {
        failed += 1;
      }
    }
    // Any operation the server did not answer must stay queued.
    for (const operation of sent) {
      if (answered.has(operation.idempotencyKey)) continue;
      await syncRepository.markRetryWait(
        operation.operationId,
        "The server did not report an outcome for this operation; it stays queued.",
      );
      failed += 1;
    }
  }

  const documentsUploaded = await uploadQueuedDocuments(ownerId, onProgress);
  // A failure while pulling must not discard or misreport the push that
  // already succeeded: the clinician's save is complete either way.
  let pullError: string | null = null;
  const pulled = await pullChanges(ownerId, deviceId).catch((error: unknown) => {
    pullError =
      error instanceof Error
        ? error.message
        : "Server changes could not be downloaded.";
    return { applied: 0, conflicts: 0 };
  });
  const documentsDownloaded = await downloadMissingDocumentContent().catch(() => 0);
  conflicts += pulled.conflicts;

  if (acknowledged > 0 || pulled.applied > 0 || documentsDownloaded > 0) {
    await recordSuccessfulSync();
  }
  await auditRepository.record({
    action: "sync.run",
    entityType: "sync",
    entityId: null,
    details: {
      acknowledged,
      conflicts,
      failed,
      downloaded: pulled.applied,
      documentsDownloaded,
    },
  });

  onProgress?.({
    phase: "done",
    total: due.length,
    completed: due.length,
    message: "Synchronization finished",
  });

  return {
    attempted,
    acknowledged,
    conflicts,
    failed,
    documentsUploaded,
    skipped: false,
    message: buildMessage(
      acknowledged,
      conflicts,
      failed,
      documentsUploaded,
      pulled.applied,
      documentsDownloaded,
      pullError,
    ),
  };
}

function buildMessage(
  acknowledged: number,
  conflicts: number,
  failed: number,
  documents: number,
  changes: number,
  documentsDownloaded: number,
  pullError: string | null,
): string {
  const parts = [`${acknowledged} operation(s) confirmed by the server`];
  if (documents) parts.push(`${documents} document(s) uploaded`);
  if (changes) parts.push(`${changes} server change(s) applied`);
  if (documentsDownloaded) {
    parts.push(`${documentsDownloaded} document(s) downloaded and verified`);
  }
  if (conflicts) parts.push(`${conflicts} conflict(s) need clinician review`);
  if (failed) parts.push(`${failed} operation(s) still queued for retry`);
  // Reported plainly: what was pushed is safe even when the download half
  // of synchronization failed.
  if (pullError) parts.push(`server changes could not be downloaded (${pullError})`);
  return `${parts.join("; ")}.`;
}

async function pullChanges(
  ownerId: string,
  deviceId: string,
): Promise<{ applied: number; conflicts: number }> {
  let cursor = await syncPullRepository.getCursor(ownerId);
  let applied = 0;
  let conflicts = 0;

  for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
    const response = await api.pullChanges(deviceId, cursor, 200);
    if (response.changes.length && response.next_cursor <= cursor) {
      throw new Error(
        "The server returned a synchronization page without advancing its cursor.",
      );
    }
    const page = await syncPullRepository.applyPage(
      ownerId,
      response.changes,
      response.next_cursor,
    );
    applied += page.applied;
    conflicts += page.conflicts;
    cursor = response.next_cursor;
    if (!response.has_more) break;
  }
  return { applied, conflicts };
}

function deviceLabel(): string {
  if (typeof navigator === "undefined") return "Browser";
  const agent = navigator.userAgent;
  if (/Android/i.test(agent)) return "Android browser";
  if (/iPhone|iPad/i.test(agent)) return "iOS browser";
  if (/Windows/i.test(agent)) return "Windows browser";
  if (/Mac OS X/i.test(agent)) return "macOS browser";
  return "Browser";
}

/**
 * Starts automatic foreground synchronization: when the API becomes
 * reachable, when the app is brought back to the foreground, and on a slow
 * safety interval. Background Sync is never required for correctness.
 */
export function startSyncScheduler(
  ownerId: string,
  onOutcome?: (outcome: SyncOutcome) => void,
): () => void {
  if (typeof window === "undefined") return () => undefined;
  let stopped = false;

  const attempt = () => {
    if (stopped || !isVaultUnlocked()) return;
    void syncNow(ownerId)
      .then((outcome) => {
        if (!stopped && !outcome.skipped) onOutcome?.(outcome);
      })
      .catch(() => undefined);
  };

  const unsubscribe = onApiReconnected(attempt);
  const onVisible = () => {
    if (document.visibilityState === "visible") attempt();
  };
  document.addEventListener("visibilitychange", onVisible);
  const interval = setInterval(attempt, 2 * 60 * 1000);
  attempt();

  return () => {
    stopped = true;
    unsubscribe();
    document.removeEventListener("visibilitychange", onVisible);
    clearInterval(interval);
  };
}

/**
 * Registers a Background Sync tag where the browser supports it. This is a
 * best-effort addition on top of foreground sync, never a requirement.
 */
export async function registerBackgroundSync(): Promise<boolean> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return false;
  try {
    const registration = await navigator.serviceWorker.ready;
    const sync = (registration as ServiceWorkerRegistration & {
      sync?: { register: (tag: string) => Promise<void> };
    }).sync;
    if (!sync) return false;
    await sync.register("syncarex-operations");
    return true;
  } catch {
    return false;
  }
}
