import { db } from "../database/db";
import type {
  AIArtifactKind,
  AIArtifactStatus,
  LocalAIBlob,
  LocalAIArtifact,
} from "../database/types";
import { requireUnlockedIdentity } from "../security/localVault";
import { getLocalDeviceId } from "../offline/device";
import {
  decryptLocalBytes,
  decryptLocalValue,
  encryptLocalBytes,
  encryptLocalValue,
} from "../security/localVault";
import { auditRepository } from "./auditRepository";

const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const SOURCE_KINDS = new Set<AIArtifactKind>(["audio_source", "document_source"]);

export interface DecryptedAIArtifact<T extends Record<string, unknown> = Record<string, unknown>>
  extends LocalAIArtifact {
  payload: T;
}

function assertOwned(artifact: LocalAIArtifact, ownerId: string): void {
  if (artifact.ownerId !== ownerId) {
    throw new Error("This AI artifact belongs to another local account.");
  }
}

export const aiRepository = {
  async saveArtifact<T extends Record<string, unknown>>(
    kind: AIArtifactKind,
    payload: T,
    status: AIArtifactStatus = "saved",
  ): Promise<DecryptedAIArtifact<T>> {
    const identity = requireUnlockedIdentity("save local AI work");
    const deviceId = await getLocalDeviceId();
    const now = new Date().toISOString();
    const artifact: LocalAIArtifact = {
      id: crypto.randomUUID(),
      ownerId: identity.userId,
      actorId: identity.userId,
      deviceId,
      kind,
      status,
      encrypted: await encryptLocalValue(payload),
      createdAt: now,
      updatedAt: now,
    };
    await db.aiArtifacts.add(artifact);
    await auditRepository.record({
      action: `ai.${kind}.save.local`,
      entityType: "aiArtifact",
      entityId: artifact.id,
      details: { status },
    });
    return { ...artifact, payload };
  },

  async saveSource(
    kind: Extract<AIArtifactKind, "audio_source" | "document_source">,
    file: File,
  ): Promise<DecryptedAIArtifact<{ fileName: string; mimeType: string; blobId: string }>> {
    const identity = requireUnlockedIdentity("save AI source files");
    if (!SOURCE_KINDS.has(kind)) throw new Error("Unsupported AI source type.");
    if (file.size === 0 || file.size > MAX_SOURCE_BYTES) {
      throw new Error("Choose a non-empty source file of 25 MiB or smaller.");
    }

    const deviceId = await getLocalDeviceId();
    const now = new Date().toISOString();
    const blobId = crypto.randomUUID();
    const encryptedBlob = await encryptLocalBytes(await file.arrayBuffer());
    const blob: LocalAIBlob = {
      id: blobId,
      ownerId: identity.userId,
      ...encryptedBlob,
      byteSize: file.size,
      createdAt: now,
    };
    const payload = {
      fileName: file.name,
      mimeType: file.type || "application/octet-stream",
      blobId,
    };
    const artifact: LocalAIArtifact = {
      id: crypto.randomUUID(),
      ownerId: identity.userId,
      actorId: identity.userId,
      deviceId,
      kind,
      status: "saved",
      encrypted: await encryptLocalValue(payload),
      createdAt: now,
      updatedAt: now,
    };
    await db.transaction("rw", db.aiBlobs, db.aiArtifacts, async () => {
      await db.aiBlobs.add(blob);
      await db.aiArtifacts.add(artifact);
    });
    await auditRepository.record({
      action: `ai.${kind}.save.local`,
      entityType: "aiArtifact",
      entityId: artifact.id,
      details: { byteSize: file.size },
    });
    return { ...artifact, payload };
  },

  async getLocal<T extends Record<string, unknown> = Record<string, unknown>>(
    id: string,
  ): Promise<DecryptedAIArtifact<T> | null> {
    const identity = requireUnlockedIdentity("read local AI work");
    const artifact = await db.aiArtifacts.get(id);
    if (!artifact) return null;
    assertOwned(artifact, identity.userId);
    return {
      ...artifact,
      payload: await decryptLocalValue<T>(artifact.encrypted),
    };
  },

  async listLocal(): Promise<DecryptedAIArtifact[]> {
    const identity = requireUnlockedIdentity("list local AI work");
    const artifacts = await db.aiArtifacts
      .where("ownerId")
      .equals(identity.userId)
      .toArray();
    artifacts.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return Promise.all(
      artifacts.map(async (artifact) => ({
        ...artifact,
        payload: await decryptLocalValue<Record<string, unknown>>(artifact.encrypted),
      })),
    );
  },

  async updateLocal<T extends Record<string, unknown>>(
    id: string,
    payload: T,
    status: AIArtifactStatus,
  ): Promise<DecryptedAIArtifact<T>> {
    const identity = requireUnlockedIdentity("update local AI work");
    const current = await db.aiArtifacts.get(id);
    if (!current) throw new Error("AI artifact was not found on this device.");
    assertOwned(current, identity.userId);
    const updated: LocalAIArtifact = {
      ...current,
      status,
      encrypted: await encryptLocalValue(payload),
      updatedAt: new Date().toISOString(),
    };
    await db.aiArtifacts.put(updated);
    return { ...updated, payload };
  },

  async openSource(id: string): Promise<{ blob: Blob; fileName: string } | null> {
    const artifact = await this.getLocal<{ fileName: string; mimeType: string; blobId: string }>(
      id,
    );
    if (!artifact || !SOURCE_KINDS.has(artifact.kind)) return null;
    const identity = requireUnlockedIdentity("open local AI source files");
    const source = await db.aiBlobs.get(artifact.payload.blobId);
    if (!source) return null;
    if (source.ownerId !== identity.userId) {
      throw new Error("This AI source file belongs to another local account.");
    }
    const bytes = await decryptLocalBytes(source.iv, source.ciphertext);
    return {
      blob: new Blob([bytes], { type: artifact.payload.mimeType }),
      fileName: artifact.payload.fileName,
    };
  },
};
