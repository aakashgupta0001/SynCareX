import type { LocalPatient } from "../database/types";

export const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "/api/v1";
let accessToken: string | null = null;
let refreshInFlight: Promise<string | null> | null = null;
let restoreInFlight: Promise<AuthResponse | null> | null = null;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface AuthUser {
  id: string;
  clinic_id: string;
  email: string;
  full_name: string;
  roles: { name: string; permissions: string[] }[];
}

interface AuthResponse {
  access_token: string;
  token_type: "bearer";
  user: AuthUser;
}

export interface PatientResponse {
  id: string;
  clinic_id: string;
  patient_number: string;
  full_name: string;
  date_of_birth: string | null;
  estimated_age: number | null;
  gender: string | null;
  contact_phone: string | null;
  address: string | null;
  village: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  relevant_history: string | null;
  allergies: string[];
  version: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export function mapPatientFromApi(patient: PatientResponse): LocalPatient {
  return {
    id: patient.id,
    patientNumber: patient.patient_number,
    fullName: patient.full_name,
    dateOfBirth: patient.date_of_birth,
    estimatedAge: patient.estimated_age,
    gender: patient.gender ?? "",
    contactPhone: patient.contact_phone ?? "",
    address: patient.address ?? "",
    village: patient.village ?? "",
    emergencyContactName: patient.emergency_contact_name ?? "",
    emergencyContactPhone: patient.emergency_contact_phone ?? "",
    relevantHistory: patient.relevant_history ?? "",
    allergies: patient.allergies,
    version: patient.version,
    createdAt: patient.created_at,
    updatedAt: patient.updated_at,
    archivedAt: patient.archived_at,
  };
}

function mapPatientToApi(patient: LocalPatient): Record<string, unknown> {
  return {
    id: patient.id,
    full_name: patient.fullName,
    date_of_birth: patient.dateOfBirth,
    estimated_age: patient.estimatedAge,
    gender: patient.gender || null,
    contact_phone: patient.contactPhone || null,
    address: patient.address || null,
    village: patient.village || null,
    emergency_contact_name: patient.emergencyContactName || null,
    emergency_contact_phone: patient.emergencyContactPhone || null,
    relevant_history: patient.relevantHistory || null,
    allergies: patient.allergies,
  };
}

export function mapPatientChangesToApi(
  changes: Record<string, unknown>,
): Record<string, unknown> {
  const fieldNames: Record<string, string> = {
    fullName: "full_name",
    dateOfBirth: "date_of_birth",
    estimatedAge: "estimated_age",
    gender: "gender",
    contactPhone: "contact_phone",
    address: "address",
    village: "village",
    emergencyContactName: "emergency_contact_name",
    emergencyContactPhone: "emergency_contact_phone",
    relevantHistory: "relevant_history",
    allergies: "allergies",
  };
  return Object.fromEntries(
    Object.entries(changes)
      .filter(([key]) => key in fieldNames)
      .map(([key, value]) => [fieldNames[key], value]),
  );
}

export interface SealedContentRequest {
  ciphertext: string;
  iv: string;
  key_epoch: number;
}

export interface SyncOperationRequest {
  operation_id: string;
  idempotency_key: string;
  actor_id: string | null;
  device_id: string;
  schema_version: number;
  entity_type: string;
  entity_id: string;
  operation_type: string;
  base_version: number;
  local_version: number;
  payload: Record<string, unknown>;
  // Dual-write: the same content encrypted with the clinic key, and
  // keyed hashes of its searchable trigrams. Both omitted when this
  // device has no clinic key.
  sealed_content?: SealedContentRequest;
  search_terms?: string[];
  created_at: string;
}

export interface SyncOperationResult {
  operation_id: string;
  idempotency_key: string;
  entity_type: string;
  entity_id: string;
  status: "acknowledged" | "conflict" | "rejected";
  duplicate: boolean;
  retryable: boolean;
  server_version: number | null;
  message: string | null;
  entity: Record<string, unknown> | null;
}

export interface SyncBatchResponse {
  results: SyncOperationResult[];
  server_time: string;
  acknowledged: number;
  conflicts: number;
  rejected: number;
}

export interface SyncChangeResponse {
  cursor: number;
  operation_id: string | null;
  entity_type: string;
  entity_id: string;
  operation_type: string;
  entity_version: number;
  payload: Record<string, unknown>;
  tombstone: boolean;
  created_at: string;
}

export interface SyncPullResponse {
  changes: SyncChangeResponse[];
  next_cursor: number;
  has_more: boolean;
}

export interface DeviceProvisionResponse {
  device_id: string;
  server_device_id: string;
  status: string;
  offline_grace_days: number;
  provisioned_at: string;
}

export interface ConflictFieldDecisionRequest {
  field: string;
  choice: "local" | "server";
  local_value?: unknown;
  server_value?: unknown;
}

export interface ConflictResolutionRequest {
  entity_type: string;
  entity_id: string;
  base_version: number;
  winning_version: number;
  winner_source: "local" | "server" | "merged";
  field_decisions: ConflictFieldDecisionRequest[];
}

export interface ConflictResolutionResponse {
  id: string;
  clinic_id: string;
  entity_type: string;
  entity_id: string;
  base_version: number;
  winning_version: number;
  winner_source: string;
  resolved_by: string;
  field_decisions: ConflictFieldDecisionRequest[] | null;
  resolved_at: string;
}

export interface DocumentResponse {
  id: string;
  patient_id: string;
  consultation_id: string | null;
  file_name: string;
  mime_type: string;
  byte_size: number;
  checksum: string;
  description: string | null;
  content_received_at: string | null;
  created_at: string;
}

export interface ChunkedUploadInitInput {
  patient_id: string;
  document_id: string | null;
  file_name: string;
  content_type: string;
  byte_size: number;
  /** SHA-256 hex of the whole file, verified again at completion. */
  total_checksum: string;
  chunk_size: number;
  description?: string | null;
}

export interface ChunkedUploadInitResponse {
  upload_id: string;
  chunk_size: number;
  total_chunks: number;
}

export interface ChunkedUploadStatusResponse {
  upload_id: string;
  chunk_size: number;
  byte_size: number;
  total_chunks: number;
  received_indexes: number[];
  missing_indexes: number[];
}

export interface ChunkedPartResponse {
  index: number;
  received: boolean;
  missing_indexes: number[];
}

export type ClinicKeyWrapType = "passphrase" | "identity";

export interface ClinicKeyWrapResponse {
  clinic_id: string;
  user_id: string;
  key_epoch: number;
  wrapped_key: string;
  wrap_iv: string;
  kdf_salt: string;
  kdf_iterations: number;
  /**
   * How this wrap is sealed. "passphrase" (default) uses a PBKDF2-derived
   * KEK; "identity" uses ECDH to the recipient's identity key, in which case
   * `ephemeral_public_key` carries the sender's ephemeral public JWK and
   * `kdf_salt` is empty.
   */
  wrap_type?: ClinicKeyWrapType;
  ephemeral_public_key?: string | null;
  created_at: string;
}

export interface ClinicKeyStatusResponse {
  clinic_id: string;
  key_epoch: number | null;
  wrapped_for_this_user: boolean;
  user_count_with_access: number;
  records_encrypted: boolean;
}

export interface ClinicKeyWrapInput {
  user_id: string;
  key_epoch: number;
  wrapped_key: string;
  wrap_iv: string;
  /** Required for passphrase wraps; identity wraps must omit it (or send ""). */
  kdf_salt?: string;
  /** Required for passphrase wraps; identity wraps must omit it. */
  kdf_iterations?: number;
  /** Defaults to "passphrase" server-side. */
  wrap_type?: ClinicKeyWrapType;
  /** Required for identity wraps; must be omitted/empty for passphrase wraps. */
  ephemeral_public_key?: string;
}

export interface IdentityKeyResponse {
  user_id: string;
  /** JSON serialization of an ECDH P-256 public JWK. */
  public_key: string;
  created_at: string;
}

export interface ClinicMemberResponse {
  id: string;
  email: string;
  full_name: string;
  holds_clinic_key: boolean;
  has_identity_key: boolean;
}

/** Returned once when staff enable the patient portal for a patient. */
export interface PatientPortalAccountResponse {
  patient_id: string;
  email: string;
  enrollment_code: string;
  enrollment_code_expires_at: string;
}

/** Current state of a patient's portal account. 404 when none exists. */
export interface PatientPortalAccountStatusResponse {
  email: string;
  enrolled: boolean;
  is_active: boolean;
  created_at: string;
}

interface PatientPage {
  items: PatientResponse[];
  page: number;
  page_size: number;
  total: number;
  pages: number;
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export async function checkApiHealth(): Promise<{
  ok: boolean;
  error: string | null;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    // API_BASE may be relative (same-origin proxy deployments), where the
    // two-argument URL constructor would throw.
    const healthUrl = API_BASE.startsWith("http")
      ? new URL("/health", API_BASE).toString()
      : "/health";
    const response = await fetch(healthUrl, {
      signal: controller.signal,
      credentials: "omit",
    });
    if (!response.ok) {
      return { ok: false, error: `Health check returned HTTP ${response.status}.` };
    }
    const body = (await response.json()) as { status?: unknown };
    if (body.status !== "ok") {
      return { ok: false, error: "The SynCareX API health check was unsuccessful." };
    }
    return { ok: true, error: null };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "The SynCareX API health check failed.",
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function refreshAccessToken(): Promise<string | null> {
  if (!refreshInFlight) {
    refreshInFlight = fetch(`${API_BASE}/auth/refresh`, {
      method: "POST",
      credentials: "include",
    })
      .then(async (response) => {
        if (!response.ok) return null;
        const result = (await response.json()) as AuthResponse;
        accessToken = result.access_token;
        return result.access_token;
      })
      .catch(() => null)
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

async function apiRequest<T>(
  path: string,
  init: RequestInit = {},
  retry = true,
): Promise<T> {
  const headers = new Headers(init.headers);
  const isFormData =
    typeof FormData !== "undefined" && init.body instanceof FormData;
  if (init.body && !isFormData && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers,
      credentials: "include",
    });
  } catch {
    throw new ApiError(
      "The SynCareX API is unreachable. Your local changes remain saved on this device.",
      0,
    );
  }
  if (response.status === 401 && retry && accessToken) {
    const refreshed = await refreshAccessToken();
    if (refreshed) return apiRequest<T>(path, init, false);
    accessToken = null;
  }
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = (await response.json()) as { detail?: unknown };
      message =
        typeof body.detail === "string"
          ? body.detail
          : body.detail
            ? JSON.stringify(body.detail)
            : message;
    } catch {
      // The response body may not be JSON; keep the explicit HTTP status.
    }
    throw new ApiError(message, response.status);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  restoreSession(): Promise<AuthResponse | null> {
    if (!restoreInFlight) {
      restoreInFlight = (async () => {
        let response: Response;
        try {
          response = await fetch(`${API_BASE}/auth/refresh`, {
            method: "POST",
            credentials: "include",
          });
        } catch {
          throw new ApiError("The SynCareX API is unreachable.", 0);
        }
        if (response.status === 401) return null;
        if (!response.ok) {
          throw new ApiError(
            `Session restore failed (${response.status}).`,
            response.status,
          );
        }
        const result = (await response.json()) as AuthResponse;
        setAccessToken(result.access_token);
        return result;
      })().finally(() => {
        restoreInFlight = null;
      });
    }
    return restoreInFlight;
  },

  async login(email: string, password: string): Promise<AuthResponse> {
    const result = await apiRequest<AuthResponse>(
      "/auth/login",
      {
        method: "POST",
        body: JSON.stringify({ email, password }),
      },
      false,
    );
    setAccessToken(result.access_token);
    return result;
  },

  async logout(): Promise<void> {
    await apiRequest<void>("/auth/logout", { method: "POST" }, false);
  },

  /**
   * Lists patients. When `searchTerms` is supplied the query itself is never
   * sent: the server matches keyed hashes, which is what keeps search
   * working once it can no longer read names.
   */
  async listPatients(search = "", searchTerms: string[] = []): Promise<PatientPage> {
    const params = new URLSearchParams({ page: "1", page_size: "100" });
    for (const term of searchTerms) params.append("search_terms", term);
    // During dual-write the plaintext query is still sent so the server can
    // find patients that have no hashed terms yet (synced before the index,
    // or by a device without the clinic key).
    if (search.trim()) params.set("search", search.trim());
    return apiRequest<PatientPage>(`/patients?${params}`);
  },

  async getPatient(patientId: string): Promise<PatientResponse> {
    return apiRequest<PatientResponse>(`/patients/${patientId}`);
  },

  async createPatient(patient: LocalPatient): Promise<PatientResponse> {
    return apiRequest<PatientResponse>("/patients", {
      method: "POST",
      body: JSON.stringify(mapPatientToApi(patient)),
    });
  },

  async updatePatient(
    patientId: string,
    payload: Record<string, unknown>,
  ): Promise<PatientResponse> {
    return apiRequest<PatientResponse>(`/patients/${patientId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
  },

  /**
   * Authorizes this browser for offline clinical work. Requires a live
   * server session; it is never called while offline.
   */
  async provisionDevice(
    deviceId: string,
    label: string,
  ): Promise<DeviceProvisionResponse> {
    return apiRequest<DeviceProvisionResponse>("/sync/devices/provision", {
      method: "POST",
      body: JSON.stringify({ device_id: deviceId, label }),
    });
  },

  /** Sends a batch of queued operations and returns one result per operation. */
  async syncOperations(
    deviceId: string,
    operations: SyncOperationRequest[],
  ): Promise<SyncBatchResponse> {
    return apiRequest<SyncBatchResponse>("/sync/operations", {
      method: "POST",
      body: JSON.stringify({ device_id: deviceId, operations }),
    });
  },

  async pullChanges(
    deviceId: string,
    cursor: number,
    limit = 200,
  ): Promise<SyncPullResponse> {
    const query = new URLSearchParams({
      device_id: deviceId,
      cursor: String(cursor),
      limit: String(limit),
    });
    return apiRequest<SyncPullResponse>(`/sync/changes?${query.toString()}`);
  },

  /**
   * Publishes a clinician's conflict decision to the server: who resolved
   * what, when, and which version won. Evidence only — the resolved record
   * itself travels through the normal operation queue.
   */
  async publishConflictResolution(
    resolution: ConflictResolutionRequest,
  ): Promise<ConflictResolutionResponse> {
    return apiRequest<ConflictResolutionResponse>("/sync/conflict-resolutions", {
      method: "POST",
      body: JSON.stringify(resolution),
    });
  },

  /** Uploads document bytes for metadata the server has already accepted. */
  async uploadDocumentContent(
    documentId: string,
    fileName: string,
    mimeType: string,
    bytes: ArrayBuffer,
  ): Promise<DocumentResponse> {
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: mimeType }), fileName);
    return apiRequest<DocumentResponse>(`/documents/${documentId}/content`, {
      method: "POST",
      body: form,
    });
  },

  /** Registers a chunked upload session for a large document. */
  async initChunkedUpload(
    payload: ChunkedUploadInitInput,
  ): Promise<ChunkedUploadInitResponse> {
    return apiRequest<ChunkedUploadInitResponse>("/documents/chunks/init", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  /** Reports which parts of a chunked upload have already arrived. */
  async getChunkedUploadStatus(
    uploadId: string,
  ): Promise<ChunkedUploadStatusResponse> {
    return apiRequest<ChunkedUploadStatusResponse>(
      `/documents/chunks/${uploadId}`,
    );
  },

  /** Sends one part of a chunked upload; the checksum header is verified. */
  async uploadDocumentChunk(
    uploadId: string,
    index: number,
    bytes: ArrayBuffer,
    checksum: string,
  ): Promise<ChunkedPartResponse> {
    return apiRequest<ChunkedPartResponse>(
      `/documents/chunks/${uploadId}/${index}`,
      {
        method: "PUT",
        body: bytes,
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Chunk-Checksum": checksum,
        },
      },
    );
  },

  /** Finalizes a chunked upload and returns the stored document. */
  async completeChunkedUpload(uploadId: string): Promise<DocumentResponse> {
    return apiRequest<DocumentResponse>(
      `/documents/chunks/${uploadId}/complete`,
      { method: "POST" },
    );
  },

  async downloadDocumentContent(documentId: string): Promise<ArrayBuffer> {
    const path = `/documents/${documentId}/content`;
    const request = async (retry: boolean): Promise<ArrayBuffer> => {
      const headers = new Headers();
      if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
      let response: Response;
      try {
        response = await fetch(`${API_BASE}${path}`, {
          headers,
          credentials: "include",
        });
      } catch {
        throw new ApiError(
          "The SynCareX API is unreachable. Your local records remain available.",
          0,
        );
      }
      if (response.status === 401 && retry && accessToken) {
        if (await refreshAccessToken()) return request(false);
        accessToken = null;
      }
      if (!response.ok) {
        let message = `Document download failed (${response.status}).`;
        try {
          const body = (await response.json()) as { detail?: unknown };
          if (typeof body.detail === "string") message = body.detail;
        } catch {
          // Non-JSON error responses retain their explicit HTTP status.
        }
        throw new ApiError(message, response.status);
      }
      return response.arrayBuffer();
    };
    return request(true);
  },

  async listDocuments(patientId: string): Promise<{
    items: DocumentResponse[];
    total: number;
  }> {
    return apiRequest(`/documents?patient_id=${encodeURIComponent(patientId)}`);
  },

  /** This user's own wrapped clinic key. Opaque ciphertext. */
  async getClinicKeyWrap(): Promise<ClinicKeyWrapResponse> {
    return apiRequest<ClinicKeyWrapResponse>("/keys/clinic");
  },

  /** Whether the clinic has a key at all, and whether it is wrapped for this user. */
  async getClinicKeyStatus(): Promise<ClinicKeyStatusResponse> {
    return apiRequest<ClinicKeyStatusResponse>("/keys/clinic/status");
  },

  async publishClinicKeyWraps(
    wraps: ClinicKeyWrapInput[],
  ): Promise<ClinicKeyStatusResponse> {
    return apiRequest<ClinicKeyStatusResponse>("/keys/clinic", {
      method: "POST",
      body: JSON.stringify({ wraps }),
    });
  },

  /** Publishes (or replaces) this account's identity public key. */
  async publishIdentityKey(publicKeyJwk: string): Promise<void> {
    await apiRequest<void>("/keys/identity", {
      method: "PUT",
      body: JSON.stringify({ public_key: publicKeyJwk }),
    });
  },

  /** Another clinic member's published identity public key. 404 if none. */
  async getIdentityKey(userId: string): Promise<IdentityKeyResponse> {
    return apiRequest<IdentityKeyResponse>(
      `/keys/identity/${encodeURIComponent(userId)}`,
    );
  },

  /** Clinic members with their clinic-key and identity-key status. */
  async getClinicMembers(): Promise<ClinicMemberResponse[]> {
    return apiRequest<ClinicMemberResponse[]>("/keys/clinic/members");
  },

  /**
   * Enables the patient portal for a patient and issues the one-time
   * enrollment code. The code is shown exactly once, at creation.
   */
  async createPatientPortalAccount(
    patientId: string,
    email: string,
  ): Promise<PatientPortalAccountResponse> {
    return apiRequest<PatientPortalAccountResponse>(
      `/patients/${encodeURIComponent(patientId)}/portal-account`,
      {
        method: "POST",
        body: JSON.stringify({ email }),
      },
    );
  },

  /** The patient's portal account, or 404 (ApiError) when none exists. */
  async getPatientPortalAccount(
    patientId: string,
  ): Promise<PatientPortalAccountStatusResponse> {
    return apiRequest<PatientPortalAccountStatusResponse>(
      `/patients/${encodeURIComponent(patientId)}/portal-account`,
    );
  },

  /** Fresh one-time enrollment code when the patient lost the first one. */
  async reissuePortalEnrollmentCode(
    patientId: string,
  ): Promise<PatientPortalAccountResponse> {
    return apiRequest<PatientPortalAccountResponse>(
      `/patients/${encodeURIComponent(patientId)}/portal-account/reissue-code`,
      { method: "POST" },
    );
  },

  async listAudit(): Promise<{
    items: {
      id: string;
      actor_id: string;
      action: string;
      entity_type: string;
      entity_id: string | null;
      outcome: string;
      created_at: string;
    }[];
    page: number;
    page_size: number;
    total: number;
  }> {
    return apiRequest("/audit?page=1&page_size=100");
  },
};
