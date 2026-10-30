import type { LocalPatient } from "../database/types";

const API_BASE =
  import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:8000/api/v1";
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

export interface ClinicKeyWrapResponse {
  clinic_id: string;
  user_id: string;
  key_epoch: number;
  wrapped_key: string;
  wrap_iv: string;
  kdf_salt: string;
  kdf_iterations: number;
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
  kdf_salt: string;
  kdf_iterations: number;
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
    const response = await fetch(new URL("/health", API_BASE), {
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

  async publishClinicKeyWraps(
    wraps: ClinicKeyWrapInput[],
  ): Promise<ClinicKeyStatusResponse> {
    return apiRequest<ClinicKeyStatusResponse>("/keys/clinic", {
      method: "POST",
      body: JSON.stringify({ wraps }),
    });
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
