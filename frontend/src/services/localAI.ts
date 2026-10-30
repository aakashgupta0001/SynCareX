export interface LocalAIRuntime {
  available: boolean;
  executable: string | null;
  languages: string[];
}

export interface LocalAIStatus {
  ready: boolean;
  token_configured: boolean;
  operating_system: string;
  processor: string;
  logical_cores: number;
  accelerator_note: string;
  model_directory: string;
  total_ram_mb: number;
  available_ram_mb: number;
  free_disk_mb: number;
  runtimes: Record<string, LocalAIRuntime>;
}

export interface LocalAIModel {
  id: string;
  name: string;
  task: string;
  filename: string;
  size_bytes: number;
  sha256: string;
  minimum_free_ram_mb: number;
  runtime: string;
  languages: string[];
  license: string;
  installed: boolean;
  compatible_now: boolean;
  availability_reason: string | null;
}

export interface ExtractedFact {
  category: "symptom" | "allergy" | "medication" | "history" | "measurement" | "other";
  value: string;
  evidence: string;
  confidence: number;
}

export interface ExtractionResponse {
  facts: ExtractedFact[];
  model_id: string;
  requires_review: true;
}

const LOCAL_AI_URL = "http://127.0.0.1:8765";

async function request<T>(
  path: string,
  options: RequestInit = {},
  token?: string,
): Promise<T> {
  const headers = new Headers(options.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(`${LOCAL_AI_URL}${path}`, { ...options, headers });
  if (!response.ok) {
    let detail = `Local AI service returned ${response.status}.`;
    try {
      const body = (await response.json()) as { detail?: string };
      if (body.detail) detail = body.detail;
    } catch {
      // The service may respond with an empty body or non-JSON proxy error.
    }
    throw new Error(detail);
  }
  return (await response.json()) as T;
}

export const localAIClient = {
  status(): Promise<LocalAIStatus> {
    return request("/api/v1/status");
  },

  models(): Promise<LocalAIModel[]> {
    return request("/api/v1/models");
  },

  installModel(modelId: string, token: string): Promise<LocalAIModel> {
    return request(
      `/api/v1/models/${encodeURIComponent(modelId)}/download`,
      { method: "POST" },
      token,
    );
  },

  /**
   * `task` selects what the model produces: "transcribe" keeps the spoken
   * language, "translate" renders English. whisper translates to English
   * only, so there is no target-language argument.
   */
  transcribe(
    file: File,
    modelId: string,
    language: "auto" | "en" | "hi",
    token: string,
    task: "transcribe" | "translate" = "transcribe",
  ): Promise<{
    text: string;
    language: string;
    model_id: string;
    task: string;
    translated_to: string | null;
  }> {
    const body = new FormData();
    body.set("audio", file);
    body.set("model_id", modelId);
    body.set("language", language);
    body.set("task", task);
    return request("/api/v1/transcriptions", { method: "POST", body }, token);
  },

  ocr(
    file: File,
    language: string,
    token: string,
  ): Promise<{ text: string; language: string }> {
    const body = new FormData();
    body.set("document", file);
    body.set("language", language);
    return request("/api/v1/ocr", { method: "POST", body }, token);
  },

  extract(
    text: string,
    modelId: string,
    token: string,
  ): Promise<ExtractionResponse> {
    const body = new FormData();
    body.set("source_text", text);
    body.set("model_id", modelId);
    return request("/api/v1/extractions", { method: "POST", body }, token);
  },
};
