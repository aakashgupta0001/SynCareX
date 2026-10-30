import { API_BASE, ApiError } from "./api";

/**
 * Patient portal client. This is deliberately separate from the staff `api`
 * client: portal sessions carry their OWN access token, stored under a
 * dedicated localStorage key, and never touch (or reuse) the staff token
 * that lives in the `api` module's memory.
 */
const PORTAL_TOKEN_KEY = "syncarex_portal_access_token";

export function getPortalAccessToken(): string | null {
  try {
    return localStorage.getItem(PORTAL_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setPortalAccessToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(PORTAL_TOKEN_KEY, token);
    else localStorage.removeItem(PORTAL_TOKEN_KEY);
  } catch {
    // Storage unavailable (private mode); the session just won't persist.
  }
}

export interface PortalEnrollResponse {
  patient_id: string;
  full_name: string;
  patient_number: string;
}

export interface PortalLoginResponse {
  access_token: string;
  patient: {
    id: string;
    full_name: string;
    patient_number: string;
    clinic_name: string;
  };
}

export interface PortalSummary {
  patient: {
    full_name: string;
    patient_number: string;
    date_of_birth: string | null;
    estimated_age: number | null;
    gender: string | null;
  };
  allergies: { substance: string; reaction: string; severity: string }[];
  medications: { name: string; dose: string; frequency: string }[];
  observations: {
    label: string;
    value: string;
    unit: string;
    recorded_at: string;
  }[];
  consultations: { occurred_at: string; reason: string; status: string }[];
}

async function portalRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const token = getPortalAccessToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers,
      credentials: "omit",
    });
  } catch {
    throw new ApiError(
      "The patient portal is unreachable right now. Please try again later.",
      0,
    );
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
      // Non-JSON error responses keep the explicit HTTP status.
    }
    throw new ApiError(message, response.status);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const portalClient = {
  /** Activates a portal account with a staff-issued enrollment code. */
  async enroll(
    email: string,
    enrollmentCode: string,
    newPassword: string,
  ): Promise<PortalEnrollResponse> {
    return portalRequest<PortalEnrollResponse>("/portal/enroll", {
      method: "POST",
      body: JSON.stringify({
        email,
        enrollment_code: enrollmentCode,
        new_password: newPassword,
      }),
    });
  },

  /**
   * Signs the patient in and stores the portal token under its own key.
   * The staff `setAccessToken` is never called from here.
   */
  async login(email: string, password: string): Promise<PortalLoginResponse> {
    const result = await portalRequest<PortalLoginResponse>("/portal/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    setPortalAccessToken(result.access_token);
    return result;
  },

  /** The signed-in patient's own read-only record summary. */
  async getSummary(): Promise<PortalSummary> {
    return portalRequest<PortalSummary>("/portal/me");
  },

  /** Changes the portal password. Returns void on 204. */
  async changePassword(
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    await portalRequest<void>("/portal/password", {
      method: "POST",
      body: JSON.stringify({
        current_password: currentPassword,
        new_password: newPassword,
      }),
    });
  },

  logout(): void {
    setPortalAccessToken(null);
  },
};
