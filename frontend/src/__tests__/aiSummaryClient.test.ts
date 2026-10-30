import { afterEach, describe, expect, it, vi } from "vitest";
import { localAIClient } from "../services/localAI";

describe("local AI summarize client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("posts the transcript and ID-carrying history lines as JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          presenting_complaint: [],
          relevant_history: [],
          medications: [],
          allergies: [],
          vitals: [],
          open_questions: [],
          model_id: "qwen-0.5b-q4",
          requires_review: true,
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await localAIClient.summarize(
      "Fever for two days.",
      [{ id: "note:abc", text: "Asthma since childhood." }],
      "qwen-0.5b-q4",
      "local-token",
    );

    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toContain("/api/v1/summaries");
    expect(init.method).toBe("POST");
    expect(init.headers.get("Authorization")).toBe("Bearer local-token");
    expect(JSON.parse(init.body)).toEqual({
      model_id: "qwen-0.5b-q4",
      transcript: "Fever for two days.",
      history: [{ id: "note:abc", text: "Asthma since childhood." }],
    });
    expect(result.requires_review).toBe(true);
  });

  it("surfaces the engine's error detail on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ detail: "Set SYNCAREX_AI_TOKEN." }), {
          status: 503,
        }),
      ),
    );

    await expect(
      localAIClient.summarize("Fever.", [], "qwen-0.5b-q4", "local-token"),
    ).rejects.toThrow("Set SYNCAREX_AI_TOKEN.");
  });
});
