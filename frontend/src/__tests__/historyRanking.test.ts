import { describe, expect, it } from "vitest";
import {
  rankHistoryEntries,
  rankHistoryLines,
  tokenizeQuery,
} from "../offline/historyRanking";

describe("local history retrieval ranking", () => {
  it("splits a query into usable terms", () => {
    expect(tokenizeQuery("blood pressure, 2024")).toEqual([
      "blood",
      "pressure",
      "2024",
    ]);
    // Single characters are noise for lexical matching.
    expect(tokenizeQuery("a b ok")).toEqual(["ok"]);
  });

  it("keeps the most relevant line when the budget is tight", () => {
    const lines = [
      `Consultation (2024-01-01): routine visit; notes: ${"filler ".repeat(40)}`,
      "Recorded observation (2024-06-02): blood pressure 118/76 mmHg",
      `Clinical note (general): ${"unrelated text ".repeat(30)}`,
    ];
    // Only room for roughly one line.
    const ranked = rankHistoryLines(lines, "blood pressure", 120);
    expect(ranked.lines).toHaveLength(1);
    expect(ranked.lines[0]).toContain("blood pressure 118/76");
  });

  it("returns selected lines in chronological order, not score order", () => {
    const lines = [
      "Consultation (2024-01-01): fever review",
      "Consultation (2024-02-01): unrelated",
      "Consultation (2024-03-01): fever fever recurring",
    ];
    const ranked = rankHistoryLines(lines, "fever", 10_000);
    // The March line scores highest but must not be hoisted above January.
    expect(ranked.lines).toEqual([
      "Consultation (2024-01-01): fever review",
      "Consultation (2024-03-01): fever fever recurring",
    ]);
  });

  it("excludes lines that do not match at all", () => {
    const lines = [
      "Recorded allergy: penicillin; reaction: rash; severity: moderate",
      "Recorded medication: paracetamol; dose: 500mg",
    ];
    const ranked = rankHistoryLines(lines, "penicillin", 10_000);
    expect(ranked.lines).toHaveLength(1);
    expect(ranked.matched).toBe(1);
    expect(ranked.truncated).toBe(false);
  });

  it("preserves order and fills the budget when there is no query", () => {
    const lines = ["first entry", "second entry", "third entry"];
    const all = rankHistoryLines(lines, "", 10_000);
    expect(all.lines).toEqual(lines);
    expect(all.truncated).toBe(false);

    const capped = rankHistoryLines(lines, "   ", 20);
    expect(capped.lines).toEqual(["first entry"]);
    expect(capped.truncated).toBe(true);
  });

  it("reports when matching lines did not fit the budget", () => {
    const lines = Array.from(
      { length: 10 },
      (_, index) => `Consultation (2024-0${index}-01): fever review number ${index}`,
    );
    const ranked = rankHistoryLines(lines, "fever", 90);
    expect(ranked.matched).toBe(10);
    expect(ranked.lines.length).toBeLessThan(10);
    expect(ranked.truncated).toBe(true);
  });

  it("prefers a precise line over a verbose one mentioning the term once", () => {
    const verbose = `Clinical note (general): ${"context ".repeat(60)} allergy`;
    const precise = "Recorded allergy: penicillin; severity: severe";
    const ranked = rankHistoryLines([verbose, precise], "allergy", 10_000);
    expect(ranked.lines).toHaveLength(2);

    // With room for only one, the precise line wins on length normalization.
    const tight = rankHistoryLines([verbose, precise], "allergy", 60);
    expect(tight.lines).toEqual([precise]);
  });

  it("ranks entries with their IDs intact, so a summary can cite them", () => {
    const entries = [
      { id: "consultation:1", text: "Consultation (2024-01-01): fever review" },
      { id: "note:2", text: "Clinical note (general): unrelated" },
      { id: "consultation:3", text: "Consultation (2024-03-01): fever recurring" },
    ];
    const ranked = rankHistoryEntries(
      entries,
      (entry) => entry.text,
      "fever",
      10_000,
    );
    // The IDs travel with the selected lines: these are what the structured
    // summary cites so every point traces back to a record.
    expect(ranked.entries.map((entry) => entry.id)).toEqual([
      "consultation:1",
      "consultation:3",
    ]);
    expect(ranked.entries.every((entry) => entry.text.includes("fever"))).toBe(
      true,
    );
  });
});
