"""Evaluation metrics for the local AI features.

Standard, dependency-free implementations so the numbers are comparable to
anything else that reports WER or CER. Nothing here calls a model; the
runner in run_evals.py feeds real outputs into these functions.

- WER (word error rate) for speech-to-text.
- CER (character error rate) for OCR, where word segmentation is unreliable.
- Fact precision/recall for structured extraction, matched on category and
  normalized value, because the extraction contract is "explicit facts only"
  and a partially-right value is still clinically useless.
"""

from __future__ import annotations

import unicodedata
from dataclasses import dataclass


def _edit_distance(left: list[str], right: list[str]) -> int:
    """Levenshtein distance over token sequences, O(len(left) * len(right))."""
    previous = list(range(len(right) + 1))
    for i, left_token in enumerate(left, start=1):
        current = [i]
        for j, right_token in enumerate(right, start=1):
            current.append(
                min(
                    previous[j] + 1,  # deletion
                    current[j - 1] + 1,  # insertion
                    previous[j - 1] + (left_token != right_token),  # substitution
                )
            )
        previous = current
    return previous[-1]


def _tokens(value: str) -> list[str]:
    return value.split()


def wer(reference: str, hypothesis: str) -> float:
    """Word error rate: edits / reference words. 0.0 is a perfect transcript."""
    reference_tokens = _tokens(reference.strip())
    if not reference_tokens:
        raise ValueError("WER needs a non-empty reference transcript.")
    return _edit_distance(reference_tokens, _tokens(hypothesis.strip())) / len(
        reference_tokens
    )


def cer(reference: str, hypothesis: str) -> float:
    """Character error rate: edits / reference characters, whitespace ignored.

    OCR output commonly mangles spacing, so whitespace is stripped before
    comparison; a wrong space between words is not a clinically different
    reading of "paracetamol".
    """
    reference_chars = [c for c in reference if not c.isspace()]
    if not reference_chars:
        raise ValueError("CER needs a non-empty reference document.")
    hypothesis_chars = [c for c in hypothesis if not c.isspace()]
    return _edit_distance(reference_chars, hypothesis_chars) / len(reference_chars)


def normalize_fact_value(value: str) -> str:
    """Loose value normalization for fact matching.

    Case and punctuation are noise; NFC so Devanagari matras decompose the
    same way on both sides. Everything else is left alone: "500 mg" and
    "500mg" SHOULD count as different readings during evaluation, because a
    dose rendered without its unit separator is exactly the kind of small
    error a clinician needs to catch.
    """
    normalized = unicodedata.normalize("NFC", value.strip().lower())
    return "".join(c for c in normalized if c.isalnum())


@dataclass
class FactScores:
    true_positives: int
    false_positives: int
    false_negatives: int

    @property
    def precision(self) -> float:
        denominator = self.true_positives + self.false_positives
        return self.true_positives / denominator if denominator else 0.0

    @property
    def recall(self) -> float:
        denominator = self.true_positives + self.false_negatives
        return self.true_positives / denominator if denominator else 0.0

    @property
    def f1(self) -> float:
        p, r = self.precision, self.recall
        return 2 * p * r / (p + r) if p + r else 0.0


def fact_precision_recall(
    expected: list[dict[str, str]],
    extracted: list[dict[str, str]],
    *,
    value_key: str = "value",
    category_key: str = "category",
) -> FactScores:
    """Matches facts on (category, normalized value).

    A fact counts as found only when both the category and the value match a
    remaining (unmatched) expected fact — one correct extraction cannot score
    twice. Duplicates on either side count as the extra false positives or
    false negatives they clinically are.
    """
    remaining = [
        (str(fact.get(category_key, "")), normalize_fact_value(str(fact.get(value_key, ""))))
        for fact in expected
    ]
    true_positives = 0
    false_positives = 0
    for fact in extracted:
        candidate = (
            str(fact.get(category_key, "")),
            normalize_fact_value(str(fact.get(value_key, ""))),
        )
        if candidate in remaining:
            remaining.remove(candidate)
            true_positives += 1
        else:
            false_positives += 1
    return FactScores(
        true_positives=true_positives,
        false_positives=false_positives,
        false_negatives=len(remaining),
    )
