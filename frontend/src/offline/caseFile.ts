/**
 * Turns clinician-accepted AI facts into a structured case file.
 *
 * This is the step that closes the loop from voice note or scanned document
 * to the patient record: only facts a clinician explicitly accepted are used,
 * every line keeps its verbatim source quote, and nothing is inferred. The
 * function is pure; the caller writes the plan through the normal local
 * repositories, so every record is encrypted, versioned and queued for sync
 * like any hand-entered record.
 */

import type { ExtractedFact } from "../services/localAI";

/** Server limits for the structured fields (backend/app/schemas/clinical.py). */
const MAX_FIELD = 160;
const MAX_NOTE = 20_000;

export const CASE_FILE_REASON = "AI-assisted case file (clinician reviewed)";
export const OBSERVATION_CODE = "ai-reviewed-measurement";
export const OBSERVATION_LABEL = "Measurement from reviewed source";

const SECTIONS: Array<{ category: ExtractedFact["category"]; heading: string }> = [
  { category: "symptom", heading: "Presenting symptoms" },
  { category: "history", heading: "Relevant history" },
  { category: "measurement", heading: "Measurements" },
  { category: "medication", heading: "Medications" },
  { category: "allergy", heading: "Allergies" },
  { category: "other", heading: "Other recorded facts" },
];

export interface CaseFilePlan {
  noteBody: string;
  allergies: Array<{ substance: string }>;
  medications: Array<{ name: string }>;
  observations: Array<{ code: string; label: string; value: string }>;
  /** Accepted facts too long for a structured field; they stay in the note. */
  noteOnly: ExtractedFact[];
}

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function fitsField(value: string): boolean {
  return value.length > 0 && value.length <= MAX_FIELD;
}

export function buildCaseFile(
  acceptedFacts: ExtractedFact[],
  options: { sourceArtifactId: string; reviewedAt: string },
): CaseFilePlan {
  const facts = acceptedFacts
    .map((fact) => ({ ...fact, value: clean(fact.value), evidence: clean(fact.evidence) }))
    .filter((fact) => fact.value.length > 0);
  if (!facts.length) {
    throw new Error("Accept at least one reviewed fact before adding it to the record.");
  }

  const plan: CaseFilePlan = {
    noteBody: "",
    allergies: [],
    medications: [],
    observations: [],
    noteOnly: [],
  };

  // One record and one note line per distinct value, so a fact quoted twice
  // in the source does not become two allergies.
  const seen = new Set<string>();
  const unique: ExtractedFact[] = [];
  for (const fact of facts) {
    const key = `${fact.category}:${fact.value.toLocaleLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(fact);
    if (fact.category === "allergy" || fact.category === "medication" || fact.category === "measurement") {
      if (!fitsField(fact.value)) {
        plan.noteOnly.push(fact);
        continue;
      }
    }
    if (fact.category === "allergy") plan.allergies.push({ substance: fact.value });
    if (fact.category === "medication") plan.medications.push({ name: fact.value });
    if (fact.category === "measurement") {
      plan.observations.push({ code: OBSERVATION_CODE, label: OBSERVATION_LABEL, value: fact.value });
    }
  }

  const lines = [
    "Case file from AI-assisted extraction. Every line below was accepted by a clinician against its quoted source.",
    `Source artifact: ${options.sourceArtifactId} · reviewed ${options.reviewedAt}`,
  ];
  for (const section of SECTIONS) {
    const items = unique.filter((fact) => fact.category === section.category);
    if (!items.length) continue;
    lines.push("", `${section.heading}:`);
    for (const fact of items) lines.push(`- ${fact.value} (source: "${fact.evidence}")`);
  }
  let body = lines.join("\n");
  if (body.length > MAX_NOTE) {
    body = `${body.slice(0, MAX_NOTE - 60)}\n[Truncated: open the source artifact for the rest]`;
  }
  plan.noteBody = body;
  return plan;
}
