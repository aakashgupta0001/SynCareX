/**
 * Retrieval and formatting for the AI clinical summary.
 *
 * Retrieval: the patient's local history lines are ranked against the new
 * visit text, so the model sees the history most related to this visit.
 * Generation happens in the local AI engine, which numbers every line and
 * makes the model cite them. This module turns that cited result into an
 * editable draft a clinician reviews before anything reaches the record.
 */

import { rankHistoryLines } from "./historyRanking";
import type { SummaryResponse } from "../services/localAI";

/** Engine limits (ai_engine/app/summaries.py). */
export const MAX_NEW_SOURCE_CHARS = 6_000;
export const MAX_HISTORY_CHARS = 6_000;
export const MAX_HISTORY_LINES = 60;
const MAX_HISTORY_LINE_CHARS = 600;
const MAX_NOTE_CHARS = 20_000;
const MAX_APPENDIX_LINE_CHARS = 300;

export const SUMMARY_REASON = "AI clinical summary (clinician reviewed)";

export const SUMMARY_SECTIONS: ReadonlyArray<{ id: string; heading: string }> = [
  { id: "presenting_complaint", heading: "Presenting complaint" },
  { id: "relevant_history", heading: "Relevant history" },
  { id: "medications", heading: "Medications" },
  { id: "allergies", heading: "Allergies" },
  { id: "vitals", heading: "Vitals" },
];

function clean(line: string): string {
  return line.replace(/\s+/g, " ").trim();
}

/** Standing facts that matter for any visit, whatever the visit is about. */
const PINNED_PREFIXES = ["Recorded allergy:", "Recorded medication:"];

/**
 * Picks history lines for the summary, within the engine's limits.
 *
 * Allergies and recorded medications are always included first, because they
 * matter for every visit even when the visit never mentions them. The rest is
 * ranked by relevance to the new visit; when nothing overlaps, the earliest
 * lines are used instead.
 */
export function selectHistoryForSummary(historyLines: string[], newSource: string): string[] {
  const lines = historyLines
    .map(clean)
    .filter(Boolean)
    .map((line) => line.slice(0, MAX_HISTORY_LINE_CHARS));
  const isPinned = (line: string) => PINNED_PREFIXES.some((prefix) => line.startsWith(prefix));

  const chosen: string[] = [];
  let used = 0;
  for (const line of lines.filter(isPinned)) {
    if (chosen.length >= MAX_HISTORY_LINES) break;
    if (used + line.length > MAX_HISTORY_CHARS) continue;
    chosen.push(line);
    used += line.length;
  }

  const rest = lines.filter((line) => !isPinned(line));
  const budget = MAX_HISTORY_CHARS - used;
  let ranked = rankHistoryLines(rest, newSource, budget);
  if (!ranked.lines.length) ranked = rankHistoryLines(rest, "", budget);
  return [...chosen, ...ranked.lines].slice(0, MAX_HISTORY_LINES);
}

/** Turns the engine's cited statements into an editable, source-linked draft. */
export function formatSummaryDraft(result: SummaryResponse): string {
  const out: string[] = [
    "AI clinical summary: draft for clinician review.",
    "IDs in brackets point to the source lines listed at the end. Statements marked CHECK could not be matched word for word or number for number to their sources.",
  ];
  const cited = new Set<string>();
  for (const section of SUMMARY_SECTIONS) {
    const items = result.items.filter((item) => item.section === section.id);
    if (!items.length) continue;
    out.push("", `${section.heading}:`);
    for (const item of items) {
      item.sources.forEach((source) => cited.add(source));
      const check = item.support === "check" ? " (CHECK against source)" : "";
      out.push(`- ${clean(item.text)} [${item.sources.join(", ")}]${check}`);
    }
  }
  const appendix = result.source_lines.filter((line) => cited.has(line.id));
  if (appendix.length) {
    out.push("", "Sources (S = this visit, H = earlier record):");
    for (const line of appendix) {
      const text = clean(line.text);
      const shown =
        text.length > MAX_APPENDIX_LINE_CHARS ? `${text.slice(0, MAX_APPENDIX_LINE_CHARS)}…` : text;
      out.push(`[${line.id}] ${shown}`);
    }
  }
  const draft = out.join("\n");
  return draft.length > MAX_NOTE_CHARS ? draft.slice(0, MAX_NOTE_CHARS) : draft;
}
