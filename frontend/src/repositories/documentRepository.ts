import { db } from "../database/db";
import type { DocumentBlob, LocalDocument } from "../database/types";
import {
  getOwned,
  listOwnedByIndex,
  ownedBy,
  planWrite,
  readRecords,
} from "./localStore";
import { auditRepository } from "./auditRepository";
import {
  decryptLocalBytes,
  encryptLocalBytes,
  encryptLocalValue,
  requireUnlockedIdentity,
} from "../security/localVault";
import { sha256Hex, validateDocument } from "../offline/storage";

export interface DocumentSaveInput {
  patientId: string;
  consultationId?: string | null;
  file: File;
  description?: string;
}

export const documentRepository = {
  /**
   * Stores the file bytes encrypted in IndexedDB and queues the upload. The
   * local original is retained until the server acknowledges it.
   */
  async saveLocal(input: DocumentSaveInput): Promise<LocalDocument> {
    const identity = requireUnlockedIdentity("store documents");
    const problem = validateDocument(input.file);
    if (problem) throw new Error(problem);

    const bytes = await input.file.arrayBuffer();
    const checksum = await sha256Hex(bytes);
    const now = new Date().toISOString();
    const metadata: LocalDocument = {
      id: crypto.randomUUID(),
      patientId: input.patientId,
      consultationId: input.consultationId ?? null,
      fileName: input.file.name,
      mimeType: input.file.type,
      byteSize: input.file.size,
      checksum,
      description: input.description ?? "",
      uploadStatus: "queued",
      uploadError: null,
      uploadedAt: null,
      uploadId: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };

    const [plan, encryptedBytes] = await Promise.all([
      planWrite({
        entity: metadata,
        entityType: "document",
        operationType: "upload",
        baseVersion: 0,
        payload: {
          id: metadata.id,
          patient_id: metadata.patientId,
          consultation_id: metadata.consultationId,
          file_name: metadata.fileName,
          mime_type: metadata.mimeType,
          byte_size: metadata.byteSize,
          checksum: metadata.checksum,
          description: metadata.description,
        },
        meta: {
          patientId: input.patientId,
          consultationId: input.consultationId ?? undefined,
        },
        identity,
      }),
      encryptLocalBytes(bytes),
    ]);

    const blob: DocumentBlob = {
      id: metadata.id,
      ownerId: identity.userId,
      patientId: input.patientId,
      iv: encryptedBytes.iv,
      ciphertext: encryptedBytes.ciphertext,
      byteSize: input.file.size,
      createdAt: now,
    };

    await db.transaction(
      "rw",
      db.documents,
      db.documentBlobs,
      db.syncOperations,
      async () => {
        await db.documents.put(plan.record);
        await db.documentBlobs.put(blob);
        const duplicate = await db.syncOperations
          .where("dedupeKey")
          .equals(plan.operation.dedupeKey)
          .first();
        if (!duplicate) await db.syncOperations.add(plan.operation);
      },
    );

    await auditRepository.record({
      action: "document.save.local",
      entityType: "document",
      entityId: plan.entity.id,
      details: { byteSize: metadata.byteSize, mimeType: metadata.mimeType },
    });
    return plan.entity;
  },

  async getLocal(id: string): Promise<LocalDocument | null> {
    return getOwned<LocalDocument>(db.documents, id, "read documents");
  },

  async listByPatientLocal(patientId: string): Promise<LocalDocument[]> {
    const documents = await listOwnedByIndex<LocalDocument>(
      db.documents,
      "patientId",
      patientId,
      "read documents",
    );
    return documents.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  },

  async listLocal(): Promise<LocalDocument[]> {
    const identity = requireUnlockedIdentity("read documents");
    const records = (
      await db.documents.where("ownerId").equals(identity.userId).toArray()
    ).filter(ownedBy(identity));
    const documents = await readRecords<LocalDocument>(records);
    return documents.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  },

  /** Decrypts the stored bytes for an in-app preview. */
  async openLocal(id: string): Promise<Blob | null> {
    const identity = requireUnlockedIdentity("open documents");
    const metadata = await this.getLocal(id);
    const blob = await db.documentBlobs.get(id);
    if (!metadata || !blob || blob.ownerId !== identity.userId) return null;
    const bytes = await decryptLocalBytes(blob.iv, blob.ciphertext);
    const restoredChecksum = await sha256Hex(bytes);
    if (restoredChecksum !== metadata.checksum) {
      throw new Error(
        "The stored document failed its integrity check and was not opened.",
      );
    }
    return new Blob([bytes], { type: metadata.mimeType });
  },

  async readBytes(id: string): Promise<ArrayBuffer | null> {
    const identity = requireUnlockedIdentity("upload documents");
    const blob = await db.documentBlobs.get(id);
    if (!blob || blob.ownerId !== identity.userId) return null;
    return decryptLocalBytes(blob.iv, blob.ciphertext);
  },

  async hasLocalBytes(id: string): Promise<boolean> {
    const identity = requireUnlockedIdentity("check synchronized documents");
    const blob = await db.documentBlobs.get(id);
    return blob?.ownerId === identity.userId;
  },

  /** Verifies and encrypts bytes downloaded for server-owned document metadata. */
  async cacheServerContent(id: string, bytes: ArrayBuffer): Promise<void> {
    const identity = requireUnlockedIdentity("cache synchronized documents");
    const metadata = await this.getLocal(id);
    const record = await db.documents.get(id);
    if (!metadata || !record || record.ownerId !== identity.userId) {
      throw new Error("Document metadata is not available on this device.");
    }
    if (bytes.byteLength !== metadata.byteSize) {
      throw new Error("The downloaded document size does not match its registered metadata.");
    }
    if ((await sha256Hex(bytes)) !== metadata.checksum) {
      throw new Error("The downloaded document failed its checksum integrity check.");
    }
    const now = new Date().toISOString();
    const updated: LocalDocument = {
      ...metadata,
      uploadStatus: "uploaded",
      uploadError: null,
      uploadedAt: metadata.uploadedAt ?? now,
      updatedAt: now,
    };
    const [encryptedBytes, encryptedMetadata] = await Promise.all([
      encryptLocalBytes(bytes),
      encryptLocalValue(updated),
    ]);
    await db.transaction("rw", db.documents, db.documentBlobs, async () => {
      await db.documentBlobs.put({
        id,
        ownerId: identity.userId,
        patientId: metadata.patientId,
        iv: encryptedBytes.iv,
        ciphertext: encryptedBytes.ciphertext,
        byteSize: bytes.byteLength,
        createdAt: metadata.createdAt,
      });
      await db.documents.put({
        ...record,
        encrypted: encryptedMetadata,
        updatedAt: now,
      });
    });
  },

  async setUploadStatus(
    id: string,
    uploadStatus: LocalDocument["uploadStatus"],
    uploadError: string | null = null,
  ): Promise<void> {
    const identity = requireUnlockedIdentity("update documents");
    const current = await this.getLocal(id);
    if (!current) return;
    const updated: LocalDocument = {
      ...current,
      uploadStatus,
      uploadError,
      uploadedAt: uploadStatus === "uploaded" ? new Date().toISOString() : current.uploadedAt,
      updatedAt: new Date().toISOString(),
    };
    const encrypted = await encryptLocalValue(updated);
    const record = await db.documents.get(id);
    if (!record || record.ownerId !== identity.userId) return;
    await db.documents.put({ ...record, encrypted, updatedAt: updated.updatedAt });
  },

  /**
   * Persists the server's chunked upload session id (or clears it once the
   * upload completes) so a restart can resume instead of re-sending parts.
   */
  async setUploadId(id: string, uploadId: string | null): Promise<void> {
    const identity = requireUnlockedIdentity("update documents");
    const current = await this.getLocal(id);
    if (!current) return;
    const updated: LocalDocument = {
      ...current,
      uploadId,
      updatedAt: new Date().toISOString(),
    };
    const encrypted = await encryptLocalValue(updated);
    const record = await db.documents.get(id);
    if (!record || record.ownerId !== identity.userId) return;
    await db.documents.put({ ...record, encrypted, updatedAt: updated.updatedAt });
  },

  async countLocal(): Promise<number> {
    const identity = requireUnlockedIdentity("read documents");
    return db.documents.where("ownerId").equals(identity.userId).count();
  },

  async totalBytesLocal(): Promise<number> {
    const identity = requireUnlockedIdentity("read documents");
    const blobs = await db.documentBlobs.where("ownerId").equals(identity.userId).toArray();
    return blobs.reduce((total, blob) => total + blob.byteSize, 0);
  },
};
