import { describe, expect, it } from "vitest";
import { buildCaseFile, OBSERVATION_CODE } from "../offline/caseFile";
import type { ExtractedFact } from "../services/localAI";

const options = { sourceArtifactId: "artifact-1", reviewedAt: "2026-10-30T10:00:00.000Z" };

function fact(category: ExtractedFact["category"], value: string, evidence = value): ExtractedFact {
  return { category, value, evidence, confidence: 0.9 };
}

describe("case file from reviewed facts", () => {
  it("maps allergies, medications and measurements to structured records", () => {
    const plan = buildCaseFile(
      [
        fact("allergy", "Penicillin", "allergic to penicillin"),
        fact("medication", "Metformin 500 mg", "takes metformin 500 mg"),
        fact("measurement", "BP 140/90", "BP was 140/90"),
        fact("symptom", "Fever for 3 days", "bukhar teen din se"),
      ],
      options,
    );
    expect(plan.allergies).toEqual([{ substance: "Penicillin" }]);
    expect(plan.medications).toEqual([{ name: "Metformin 500 mg" }]);
    expect(plan.observations).toEqual([
      expect.objectContaining({ code: OBSERVATION_CODE, value: "BP 140/90" }),
    ]);
    // Symptoms and history live in the note, never as invented structure.
    expect(plan.noteBody).toContain("Presenting symptoms:");
    expect(plan.noteBody).toContain('- Fever for 3 days (source: "bukhar teen din se")');
  });

  it("keeps every line tied to its source and names the artifact", () => {
    const plan = buildCaseFile([fact("history", "Type 2 diabetes", "sugar ki bimari hai")], options);
    expect(plan.noteBody).toContain("Source artifact: artifact-1");
    expect(plan.noteBody).toContain('(source: "sugar ki bimari hai")');
  });

  it("does not duplicate a fact quoted twice", () => {
    const plan = buildCaseFile(
      [fact("allergy", "Penicillin", "a"), fact("allergy", "penicillin", "b")],
      options,
    );
    expect(plan.allergies).toHaveLength(1);
    expect(plan.noteBody.match(/penicillin/gi)).toHaveLength(1);
  });

  it("keeps facts too long for a structured field in the note only", () => {
    const long = "x".repeat(200);
    const plan = buildCaseFile([fact("medication", long)], options);
    expect(plan.medications).toHaveLength(0);
    expect(plan.noteOnly).toHaveLength(1);
    expect(plan.noteBody).toContain(long);
  });

  it("refuses an empty review", () => {
    expect(() => buildCaseFile([], options)).toThrow(/Accept at least one/);
  });
});
