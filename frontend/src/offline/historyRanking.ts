/**
 * Relevance ranking for the local patient-history retrieval step.
 *
 * This is the retrieval half of the extraction pipeline: it decides which of
 * a patient's locally stored history lines are sent to the local model as
 * context. Previously the lines were filtered by substring and then truncated
 * at a character budget, so which context survived depended on record order
 * rather than on relevance, and a long early note could crowd out the line
 * the clinician was actually looking for.
 *
 * **This is lexical ranking, not semantic retrieval.** It scores term
 * overlap; it has no embeddings and no notion that "BP" and "blood pressure"
 * are related. Treat it as a better filter, not as semantic search.
 */

export interface RankedHistory {
  /** Selected lines, returned in their original (chronological) order. */
  lines: string[];
  /** Lines that matched the query before the budget was applied. */
  matched: number;
  /** True when the character budget excluded some matching lines. */
  truncated: boolean;
}

export interface RankedEntries<T> {
  /** Selected entries, returned in their original (chronological) order. */
  entries: T[];
  matched: number;
  truncated: boolean;
}

/**
 * Same ranking, but for entries that carry more than their text (such as the
 * stable record IDs the structured summary cites). `textOf` supplies the
 * string that gets scored.
 */
export function rankHistoryEntries<T>(
  entries: T[],
  textOf: (entry: T) => string,
  query: string,
  budget: number,
): RankedEntries<T> {
  const ranked = rankHistoryLines(entries.map(textOf), query, budget);
  const selectedTexts = new Set(ranked.lines);
  const chosen = entries.filter((entry) => selectedTexts.has(textOf(entry)));
  return { entries: chosen, matched: ranked.matched, truncated: ranked.truncated };
}

export function tokenizeQuery(query: string): string[] {
  return query
    .normalize("NFKC")
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 1);
}

function termFrequency(line: string, token: string): number {
  const haystack = line.normalize("NFKC").toLocaleLowerCase();
  let count = 0;
  let index = haystack.indexOf(token);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(token, index + token.length);
  }
  return count;
}

/**
 * Scores a line against the query terms.
 *
 * Rare terms count for more (inverse document frequency), repeated terms
 * count for a little more but with diminishing returns, and long lines are
 * normalized so a verbose note does not outrank a precise one.
 */
function scoreLine(line: string, tokens: string[], documentFrequency: Map<string, number>, total: number): number {
  let score = 0;
  for (const token of tokens) {
    const frequency = termFrequency(line, token);
    if (!frequency) continue;
    const df = documentFrequency.get(token) ?? 1;
    const idf = Math.log(1 + total / df);
    // Saturating term frequency: the second mention adds less than the first.
    score += idf * (frequency / (frequency + 1));
  }
  const lengthPenalty = 1 + Math.log(1 + line.length / 200);
  return score / lengthPenalty;
}

/**
 * Selects the most relevant history lines that fit the character budget.
 *
 * With no query, order is preserved and the budget is applied from the start,
 * which keeps the previous behaviour for the "load everything" case.
 */
export function rankHistoryLines(
  lines: string[],
  query: string,
  budget: number,
): RankedHistory {
  const tokens = tokenizeQuery(query);

  if (!tokens.length) {
    const selected: string[] = [];
    let used = 0;
    for (const line of lines) {
      if (used + line.length > budget) break;
      selected.push(line);
      used += line.length + 1;
    }
    return {
      lines: selected,
      matched: lines.length,
      truncated: selected.length < lines.length,
    };
  }

  const documentFrequency = new Map<string, number>();
  for (const token of tokens) {
    const count = lines.filter((line) => termFrequency(line, token) > 0).length;
    if (count) documentFrequency.set(token, count);
  }

  const scored = lines
    .map((line, index) => ({
      line,
      index,
      score: scoreLine(line, tokens, documentFrequency, lines.length || 1),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index);

  const chosen: { line: string; index: number }[] = [];
  let used = 0;
  for (const entry of scored) {
    if (used + entry.line.length > budget) continue;
    chosen.push(entry);
    used += entry.line.length + 1;
  }

  // Hand the model chronological context, even though selection was by rank.
  chosen.sort((left, right) => left.index - right.index);
  return {
    lines: chosen.map((entry) => entry.line),
    matched: scored.length,
    truncated: chosen.length < scored.length,
  };
}
