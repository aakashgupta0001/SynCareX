import { api } from "./api";
import { sha256Hex } from "../offline/storage";

/**
 * Part size for chunked document uploads (~256 KB). Small enough that one
 * lost request on a 2G link costs one part, not the whole file.
 */
export const CHUNK_SIZE_BYTES = 256 * 1024;

/**
 * Files at or below this size go through the single-shot endpoint; larger
 * files are split into parts so a failed transfer can resume.
 */
export const CHUNKED_UPLOAD_THRESHOLD_BYTES = 512 * 1024;

/** Attempts per upload before the failure is surfaced to the sync engine. */
const MAX_ATTEMPTS = 3;

export interface ChunkedUploadTarget {
  documentId: string;
  patientId: string;
  fileName: string;
  mimeType: string;
  /** SHA-256 hex of the whole plaintext file. */
  checksum: string;
  description?: string;
}

export interface ChunkedUploadResume {
  /** A session id persisted from an earlier attempt, if any. */
  uploadId?: string | null;
  /** Called as soon as a session exists so the caller can persist it. */
  onUploadId?: (uploadId: string) => Promise<void> | void;
}

export interface ChunkedUploadResult {
  uploadId: string | null;
  chunked: boolean;
}

/** Number of parts the file is split into at the given part size. */
export function chunkCountFor(byteSize: number, chunkSize = CHUNK_SIZE_BYTES): number {
  return Math.max(1, Math.ceil(byteSize / chunkSize));
}

/** SHA-256 of one part of the file, matching the X-Chunk-Checksum header. */
export async function chunkChecksum(
  bytes: ArrayBuffer,
  index: number,
  chunkSize = CHUNK_SIZE_BYTES,
): Promise<string> {
  return sha256Hex(bytes.slice(index * chunkSize, (index + 1) * chunkSize));
}

async function sendMissingParts(
  uploadId: string,
  bytes: ArrayBuffer,
): Promise<void> {
  // Always ask the server what it already has: the first attempt after an
  // interruption resumes from disk, a retry within this call resumes from
  // the parts that landed before the failure.
  const status = await api.getChunkedUploadStatus(uploadId);
  for (const index of status.missing_indexes) {
    const part = bytes.slice(
      index * status.chunk_size,
      (index + 1) * status.chunk_size,
    );
    await api.uploadDocumentChunk(
      uploadId,
      index,
      part,
      await sha256Hex(part),
    );
  }
  await api.completeChunkedUpload(uploadId);
}

/**
 * Sends document bytes, chunked for large files with per-part checksums and
 * resume. Small files keep the single-shot endpoint. When a chunked transfer
 * fails, the session id is persisted through onUploadId before anything is
 * sent, so a later attempt (this process or after a restart) GETs the
 * session status and only re-sends the parts that are still missing.
 */
export async function uploadDocumentBytes(
  target: ChunkedUploadTarget,
  bytes: ArrayBuffer,
  resume: ChunkedUploadResume = {},
): Promise<ChunkedUploadResult> {
  if (bytes.byteLength <= CHUNKED_UPLOAD_THRESHOLD_BYTES) {
    await api.uploadDocumentContent(
      target.documentId,
      target.fileName,
      target.mimeType,
      bytes,
    );
    return { uploadId: null, chunked: false };
  }

  // A stale session id (session expired server-side) falls back to a new one.
  let uploadId = resume.uploadId ?? null;
  if (uploadId) {
    try {
      await api.getChunkedUploadStatus(uploadId);
    } catch {
      uploadId = null;
    }
  }
  if (!uploadId) {
    const init = await api.initChunkedUpload({
      patient_id: target.patientId,
      document_id: target.documentId,
      file_name: target.fileName,
      content_type: target.mimeType,
      byte_size: bytes.byteLength,
      total_checksum: target.checksum,
      chunk_size: CHUNK_SIZE_BYTES,
      description: target.description ?? null,
    });
    uploadId = init.upload_id;
    // Persist before the first part so a crash mid-upload can still resume.
    await resume.onUploadId?.(uploadId);
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      await sendMissingParts(uploadId, bytes);
      return { uploadId, chunked: true };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("The chunked document upload failed.");
}
