import { describe, expect, it } from "vitest";
import {
  formatSummaryDraft,
  MAX_HISTORY_CHARS,
  selectHistoryForSummary,
} from "../offline/clinicalSummary";
import type { SummaryResponse } from "../services/localAI";

const history = [
  "Recorded history: Type 2 diabetes since 2019",
  "Recorded allergy: Penicillin; reaction: rash; severity: moderate",
  "Consultation (2026-01-04): knee pain; notes: physiotherapy advised",
];

describe("history selection for the clinical summary", () => {
  it("always includes allergies, then history related to the new visit", () => {
    const selected = selectHistoryForSummary(history, "Sugar high, diabetes check, fever two days");
    // The allergy is never mentioned in the visit but must reach the model.
    expect(selected[0]).toContain("Penicillin");
    expect(selected[1]).toContain("diabetes");
    expect(selected.some((line) => line.includes("knee pain"))).toBe(false);
  });

  it("falls back to the earliest lines when nothing overlaps", () => {
    const selected = selectHistoryForSummary(history, "zzz qqq");
    expect(selected).toHaveLength(3);
    expect(new Set(selected)).toEqual(new Set(history));
  });

  it("stays inside the engine's limits", () => {
    const many = Array.from({ length: 200 }, (_, index) => `Clinical note (general): fever reading ${index} ${"x".repeat(900)}`);
    const selected = selectHistoryForSummary(many, "fever");
    expect(selected.length).toBeLessThanOrEqual(60);
    expect(selected.every((line) => line.length <= 600)).toBe(true);
    expect(selected.reduce((sum, line) => sum + line.length, 0)).toBeLessThanOrEqual(MAX_HISTORY_CHARS);
  });
});

describe("summary draft", () => {
  const result: SummaryResponse = {
    items: [
      { section: "vitals", text: "BP 150/100", sources: ["S2"], support: "check" },
      { section: "presenting_complaint", text: "Fever for 3 days", sources: ["S1"], support: "ok" },
      { section: "allergies", text: "Penicillin allergy (rash)", sources: ["H2"], support: "ok" },
    ],
    source_lines: [
      { id: "S1", text: "Fever since 3 days." },
      { id: "S2", text: "BP 140/90 today." },
      { id: "S3", text: "Not cited anywhere." },
      { id: "H1", text: "Recorded history: Type 2 diabetes" },
      { id: "H2", text: "Recorded allergy: Penicillin; reaction: rash" },
    ],
    model_id: "qwen-0.5b-q4",
    dropped: 0,
    requires_review: true,
  };

  it("groups statements by section in a fixed clinical order with their sources", () => {
    const draft = formatSummaryDraft(result);
    expect(draft.indexOf("Presenting complaint:")).toBeLessThan(draft.indexOf("Allergies:"));
    expect(draft.indexOf("Allergies:")).toBeLessThan(draft.indexOf("Vitals:"));
    expect(draft).toContain("- Fever for 3 days [S1]");
    expect(draft).toContain("- BP 150/100 [S2] (CHECK against source)");
  });

  it("lists only the cited source lines at the end", () => {
    const draft = formatSummaryDraft(result);
    expect(draft).toContain("[S2] BP 140/90 today.");
    expect(draft).toContain("[H2] Recorded allergy: Penicillin; reaction: rash");
    expect(draft).not.toContain("Not cited anywhere.");
    expect(draft).not.toContain("[H1]");
  });
});
