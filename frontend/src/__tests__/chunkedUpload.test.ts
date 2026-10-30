import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  api,
  type ChunkedUploadInitInput,
  type DocumentResponse,
} from "../services/api";
import {
  CHUNK_SIZE_BYTES,
  CHUNKED_UPLOAD_THRESHOLD_BYTES,
  chunkChecksum,
  chunkCountFor,
  uploadDocumentBytes,
} from "../services/chunkedUpload";
import { resetWorkspace } from "./helpers";

const documentResponse: DocumentResponse = {
  id: "doc-1",
  patient_id: "patient-1",
  consultation_id: null,
  file_name: "scan.pdf",
  mime_type: "application/pdf",
  byte_size: 0,
  checksum: "",
  description: null,
  content_received_at: new Date().toISOString(),
  created_at: new Date().toISOString(),
};

/** In-memory stand-in for the chunked upload endpoints. */
class FakeChunkApi {
  readonly parts = new Map<number, string>();
  readonly partPayloads: ArrayBuffer[] = [];
  readonly initCalls: Record<string, unknown>[] = [];
  readonly completeCalls: string[] = [];
  readonly statusCalls: string[] = [];
  failPart: number | null = null;
  failOnce = false;
  sessionGone = false;

  register(spies: {
    init: ReturnType<typeof vi.spyOn>;
    status: ReturnType<typeof vi.spyOn>;
    part: ReturnType<typeof vi.spyOn>;
    complete: ReturnType<typeof vi.spyOn>;
  }): void {
    spies.init.mockImplementation(async (payload: ChunkedUploadInitInput) => {
      this.initCalls.push(payload as unknown as Record<string, unknown>);
      return {
        upload_id: "upload-1",
        chunk_size: CHUNK_SIZE_BYTES,
        total_chunks: chunkCountFor(Number(payload.byte_size)),
      };
    });
    spies.status.mockImplementation(async (uploadId: string) => {
      this.statusCalls.push(uploadId);
      if (this.sessionGone) {
        // Only the resume probe hits the expired session; after the device
        // registers a fresh one, status lookups succeed.
        this.sessionGone = false;
        throw new ApiError("This upload session does not exist.", 404);
      }
      const total = 3;
      const missing: number[] = [];
      for (let index = 0; index < total; index += 1) {
        if (!this.parts.has(index)) missing.push(index);
      }
      return {
        upload_id: uploadId,
        chunk_size: CHUNK_SIZE_BYTES,
        byte_size: 600 * 1024,
        total_chunks: total,
        received_indexes: [...this.parts.keys()].sort((a, b) => a - b),
        missing_indexes: missing,
      };
    });
    spies.part.mockImplementation(
      async (_uploadId: string, index: number, bytes: ArrayBuffer, checksum: string) => {
        if (this.failPart === index) {
          if (this.failOnce) {
            this.failOnce = false;
            this.failPart = null;
          }
          throw new ApiError("The SynCareX API is unreachable.", 0);
        }
        this.parts.set(index, checksum);
        this.partPayloads.push(bytes);
        const missing: number[] = [];
        for (let candidate = 0; candidate < 3; candidate += 1) {
          if (!this.parts.has(candidate)) missing.push(candidate);
        }
        return { index, received: true, missing_indexes: missing };
      },
    );
    spies.complete.mockImplementation(async (uploadId: string) => {
      this.completeCalls.push(uploadId);
      return { ...documentResponse, id: uploadId };
    });
  }
}

describe("chunked document upload", () => {
  let spies: {
    init: ReturnType<typeof vi.spyOn>;
    status: ReturnType<typeof vi.spyOn>;
    part: ReturnType<typeof vi.spyOn>;
    complete: ReturnType<typeof vi.spyOn>;
    singleShot: ReturnType<typeof vi.spyOn>;
  };
  let fake: FakeChunkApi;

  const makeBytes = (size: number): ArrayBuffer => new ArrayBuffer(size);

  const target = {
    documentId: "doc-1",
    patientId: "patient-1",
    fileName: "scan.pdf",
    mimeType: "application/pdf",
    checksum: "a".repeat(64),
  };

  beforeEach(async () => {
    await resetWorkspace();
    fake = new FakeChunkApi();
    spies = {
      init: vi.spyOn(api, "initChunkedUpload"),
      status: vi.spyOn(api, "getChunkedUploadStatus"),
      part: vi.spyOn(api, "uploadDocumentChunk"),
      complete: vi.spyOn(api, "completeChunkedUpload"),
      singleShot: vi
        .spyOn(api, "uploadDocumentContent")
        .mockResolvedValue({ ...documentResponse, byte_size: 0 }),
    };
    fake.register(spies);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps small files on the single-shot endpoint", async () => {
    const bytes = makeBytes(CHUNKED_UPLOAD_THRESHOLD_BYTES - 1024);

    const result = await uploadDocumentBytes(target, bytes);

    expect(result.chunked).toBe(false);
    expect(result.uploadId).toBeNull();
    expect(spies.singleShot).toHaveBeenCalledWith(
      "doc-1",
      "scan.pdf",
      "application/pdf",
      bytes,
    );
    expect(spies.init).not.toHaveBeenCalled();
    expect(spies.part).not.toHaveBeenCalled();
    expect(spies.complete).not.toHaveBeenCalled();
  });

  it("sends large files in parts with per-part checksums", async () => {
    const bytes = makeBytes(CHUNKED_UPLOAD_THRESHOLD_BYTES + 88 * 1024);
    const persisted: string[] = [];

    const result = await uploadDocumentBytes(target, bytes, {
      onUploadId: (uploadId) => {
        persisted.push(uploadId);
      },
    });

    // 600 KB with 256 KB parts -> three parts.
    expect(chunkCountFor(bytes.byteLength)).toBe(3);
    expect(result.chunked).toBe(true);
    expect(result.uploadId).toBe("upload-1");
    // The session id is persisted before the first part is sent.
    expect(persisted).toEqual(["upload-1"]);

    expect(spies.init).toHaveBeenCalledTimes(1);
    expect(spies.init).toHaveBeenCalledWith(
      expect.objectContaining({
        patient_id: "patient-1",
        document_id: "doc-1",
        file_name: "scan.pdf",
        content_type: "application/pdf",
        byte_size: bytes.byteLength,
        total_checksum: target.checksum,
        chunk_size: CHUNK_SIZE_BYTES,
      }),
    );

    expect(spies.part).toHaveBeenCalledTimes(3);
    for (let index = 0; index < 3; index += 1) {
      expect(spies.part).toHaveBeenNthCalledWith(
        index + 1,
        "upload-1",
        index,
        expect.any(ArrayBuffer),
        await chunkChecksum(bytes, index),
      );
    }
    expect(spies.complete).toHaveBeenCalledWith("upload-1");
  });

  it("retries a mid-upload failure without re-sending succeeded parts", async () => {
    const bytes = makeBytes(CHUNKED_UPLOAD_THRESHOLD_BYTES + 88 * 1024);
    fake.failPart = 1;
    fake.failOnce = true;
    const persisted: string[] = [];

    const result = await uploadDocumentBytes(target, bytes, {
      onUploadId: (uploadId) => {
        persisted.push(uploadId);
      },
    });

    expect(result.chunked).toBe(true);
    // Part 0 succeeded before the cut; the retry fetched the session status
    // and only sent parts 1 and 2 again.
    expect(spies.status).toHaveBeenCalledWith("upload-1");
    // Attempt 1 sent parts 0 and 1 (cut); attempt 2 sent only 1 and 2.
    expect(spies.part).toHaveBeenCalledTimes(4);
    const sentIndexes = spies.part.mock.calls.map(
      (call: unknown[]) => call[1] as number,
    );
    expect(sentIndexes).toEqual([0, 1, 1, 2]);
    expect(
      sentIndexes.filter((index: number) => index === 0),
    ).toHaveLength(1);
    expect(spies.complete).toHaveBeenCalledTimes(1);
  });

  it("resumes after a restart using the persisted session id", async () => {
    const bytes = makeBytes(CHUNKED_UPLOAD_THRESHOLD_BYTES + 88 * 1024);
    // Parts 0 and 1 already reached the server before the app restarted.
    fake.parts.set(0, "stored");
    fake.parts.set(1, "stored");

    const result = await uploadDocumentBytes(target, bytes, {
      uploadId: "upload-persisted",
    });

    expect(result).toEqual({ uploadId: "upload-persisted", chunked: true });
    // No new session was registered; only the missing part was sent.
    expect(spies.init).not.toHaveBeenCalled();
    expect(spies.status).toHaveBeenCalledWith("upload-persisted");
    expect(spies.part).toHaveBeenCalledTimes(1);
    expect(spies.part.mock.calls[0][1]).toBe(2);
    expect(spies.complete).toHaveBeenCalledWith("upload-persisted");
  });

  it("registers a new session when the persisted one has expired", async () => {
    const bytes = makeBytes(CHUNKED_UPLOAD_THRESHOLD_BYTES + 88 * 1024);
    fake.sessionGone = true;

    const result = await uploadDocumentBytes(target, bytes, {
      uploadId: "upload-stale",
    });

    expect(result.uploadId).toBe("upload-1");
    expect(spies.init).toHaveBeenCalledTimes(1);
    expect(spies.part).toHaveBeenCalledTimes(3);
    expect(spies.complete).toHaveBeenCalledWith("upload-1");
  });

  it("surfaces the failure when every attempt fails", async () => {
    const bytes = makeBytes(CHUNKED_UPLOAD_THRESHOLD_BYTES + 88 * 1024);
    fake.failPart = 0;

    await expect(uploadDocumentBytes(target, bytes)).rejects.toThrow(
      /unreachable/i,
    );
    // Three attempts, each asking the server what is missing first.
    expect(spies.status).toHaveBeenCalledTimes(3);
    expect(spies.complete).not.toHaveBeenCalled();
  });
});
