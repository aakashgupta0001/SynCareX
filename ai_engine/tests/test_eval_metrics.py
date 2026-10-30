"""Unit tests for the evaluation metrics.

Pure functions, no model runtimes: these run everywhere the backend suite
runs and pin the math that the golden-set numbers are built on.
"""

import pytest

from ai_engine.evals.metrics import cer, fact_precision_recall, normalize_fact_value, wer


def test_wer_is_zero_for_a_perfect_transcript() -> None:
    assert wer("patient reports fever since two days", "patient reports fever since two days") == 0.0


def test_wer_counts_substitutions_insertions_and_deletions() -> None:
    # One substitution, one deletion, one insertion over five reference words.
    assert wer("fever since two days bad", "fever for two day bad cold") == pytest.approx(3 / 5)


def test_wer_scales_with_reference_length() -> None:
    assert wer("one two three four", "one too three four") == pytest.approx(0.25)


def test_wer_rejects_an_empty_reference() -> None:
    with pytest.raises(ValueError):
        wer("   ", "anything")


def test_cer_ignores_whitespace_but_counts_characters() -> None:
    # One wrong character in ten: spaces do not mask or add errors.
    assert cer("paracetamol", "paracetam0l") == pytest.approx(1 / 11)
    assert cer("paracetamol 500", "paracetamol500") == 0.0


def test_cer_handles_devanagari_after_nfc_normalization() -> None:
    # \u0928\u094b is NFC; the decomposed form must score identically.
    composed = "\u0928\u094b"
    decomposed = "\u0928" + "\u094d" + "\u200d" + "o"
    assert cer(composed, composed) == 0.0
    with pytest.raises(ValueError):
        cer("", "something")


def test_fact_matching_requires_category_and_value() -> None:
    expected = [
        {"category": "medication", "value": "paracetamol 500 mg"},
        {"category": "allergy", "value": "penicillin"},
    ]
    scores = fact_precision_recall(
        expected,
        [
            {"category": "medication", "value": "Paracetamol 500 mg!"},  # hit
            {"category": "symptom", "value": "paracetamol 500 mg"},  # wrong category
            {"category": "allergy", "value": "penicillin"},
            {"category": "allergy", "value": "sulfa"},  # hallucination
        ],
    )
    assert scores.true_positives == 2
    assert scores.false_positives == 2
    assert scores.false_negatives == 0
    assert scores.precision == pytest.approx(0.5)
    assert scores.recall == 1.0


def test_fact_matching_counts_duplicates_once() -> None:
    expected = [{"category": "medication", "value": "aspirin"}]
    scores = fact_precision_recall(
        expected,
        [
            {"category": "medication", "value": "aspirin"},
            {"category": "medication", "value": "aspirin"},
        ],
    )
    # The second copy is not a second correct fact.
    assert scores.true_positives == 1
    assert scores.false_positives == 1
    assert scores.false_negatives == 0


def test_fact_scores_on_empty_sides() -> None:
    perfect_nothing = fact_precision_recall([], [])
    assert perfect_nothing.precision == 0.0
    assert perfect_nothing.recall == 0.0
    missed_everything = fact_precision_recall(
        [{"category": "symptom", "value": "fever"}], []
    )
    assert missed_everything.recall == 0.0
    assert missed_everything.precision == 0.0


def test_value_normalization_strips_case_and_punctuation_only() -> None:
    assert normalize_fact_value("  Paracetamol, 500mg ") == "paracetamol500mg"
    # Numeric content survives: a dose change is a different fact.
    assert normalize_fact_value("500 mg") != normalize_fact_value("250 mg")
