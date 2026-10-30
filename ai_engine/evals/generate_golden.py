"""Generates the synthetic golden evaluation set.

Everything is synthetic and reproducible:

- **Printed documents** are rendered with Pillow into PNG images, so the OCR
  golden set costs nothing and carries exact expected text.
- **Voice notes** are synthesized with the Windows SAPI TTS voices available
  on this machine, for the English entries. Hindi voices are usually NOT
  installed on Windows; those manifest rows are written anyway with
  `"status": "record-manually"` so the set's shape is visible and the runner
  skips them until someone records real clips on a phone.

Run:  python -m ai_engine.evals.generate_golden
Outputs land in ai_engine/evals/golden/{speech,documents,extraction}/.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

EVALS_DIR = Path(__file__).resolve().parent
GOLDEN_DIR = EVALS_DIR / "golden"

SPEECH_DIR = GOLDEN_DIR / "speech"
DOCUMENTS_DIR = GOLDEN_DIR / "documents"
EXTRACTION_DIR = GOLDEN_DIR / "extraction"

# ---------------------------------------------------------------------------
# Speech golden set: 30 short clinical dictations. The 24 English entries are
# synthesizable anywhere Windows SAPI has a voice; the 6 Hindi entries need
# either a Hindi TTS voice or 30 seconds on a phone, so they are manifest
# rows with status "record-manually".
# ---------------------------------------------------------------------------

ENGLISH_DICTATIONS: list[tuple[str, str]] = [
    ("en-001", "Patient reports fever since two days with body ache"),
    ("en-002", "Persistent cough for one week worse at night"),
    ("en-003", "Blood pressure one fourty over ninety recorded today"),
    ("en-004", "Give paracetamol five hundred milligrams three times a day"),
    ("en-005", "Allergic to penicillin causes rash"),
    ("en-006", "Blood sugar fasting one ten post lunch one eighty"),
    ("en-007", "Vomiting since morning unable to keep fluids down"),
    ("en-008", "Start tablet metformin five hundred twice daily after food"),
    ("en-009", "Swelling over both ankles since three days"),
    ("en-010", "Advised salt restriction and daily walking thirty minutes"),
    ("en-011", "Patient complaints of headache and giddiness since evening"),
    ("en-012", "Review after seven days with fasting blood report"),
    ("en-013", "Weight sixty two kilograms height one metre sixty"),
    ("en-014", "Chest clear no wheeze heart sounds normal"),
    ("en-015", "Check hemoglobin and blood sugar fasting next visit"),
    ("en-016", "Burn injury over left forearm dressing done today"),
    ("en-017", "Diarrhea since two days give oral rehydration solution"),
    ("en-018", "Continue iron folic acid tablet once daily for one month"),
    ("en-019", "History of bronchial asthma since childhood uses inhaler"),
    ("en-020", "Follow up ultrasound abdomen after one month"),
    ("en-021", "Pulse ninety two per minute regular"),
    ("en-022", "Give tablet cetirizine ten milligrams at night for five days"),
    ("en-023", "Patient advised complete bed rest for three days"),
    ("en-024", "No history of diabetes or hypertension in family"),
]

# Kept in the manifest so the set's coverage is visible and the runner can
# report exactly what is missing. Record these on a phone in a quiet room.
HINDI_DICTATIONS: list[tuple[str, str]] = [
    ("hi-001", "बुखार दो दिन से है और सिर दर्द भी है"),
    ("hi-002", "खांसी एक हफ्ते से है रात में ज्यादा होती है"),
    ("hi-003", "पैरासिटामोल दिन में तीन बार दें"),
    ("hi-004", "पेनिसिलिन से एलर्जी है दाने निकल आते हैं"),
    ("hi-005", "ब्लड प्रेशर आज देख लिया गया है"),
    ("hi-006", "सात दिन बाद दोबारा आएं"),
]

# ---------------------------------------------------------------------------
# Printed documents: 15 rendered clinical sheets with exact expected text.
# English plus a few Devanagari lines; handwriting is deliberately out of
# scope (the pitch says printed reports are supported, handwriting is
# experimental).
# ---------------------------------------------------------------------------

ENGLISH_DOCUMENTS: list[tuple[str, str]] = [
    ("doc-en-001", "SynCareX Clinic\nPatient: Amara Cipher\nAge: 34\nComplaint: fever, body ache\nAdvice: paracetamol 500 mg TDS"),
    ("doc-en-002", "Prescription\nTab Metformin 500 mg BD\nTab Amlodipine 5 mg OD\nReview 7 days"),
    ("doc-en-003", "Lab Report\nHaemoglobin: 10.2 g/dL\nFasting sugar: 110 mg/dL\nPost prandial: 178 mg/dL"),
    ("doc-en-004", "Discharge Summary\nDiagnosis: Acute gastroenteritis\nTreatment: ORS, zinc 20 mg\nFollow up: 3 days"),
    ("doc-en-005", "Vaccination Record\nBCG given at birth\nDPT first dose completed\nNext due: 6 weeks"),
    ("doc-en-006", "Referral Note\nPatient referred to district hospital\nReason: suspected fracture right forearm\nX-ray advised"),
    ("doc-en-007", "Vitals Chart\nPulse: 92 per minute\nBP: 140/90 mmHg\nTemperature: 100.2 F"),
    ("doc-en-008", "Antenatal Card\nLMP noted\nIron folic acid daily\nANC visit 2 scheduled"),
    ("doc-en-009", "Allergy Record\nPenicillin - rash\nSulfa drugs - itching\nNo food allergies known"),
    ("doc-en-010", "Follow Up Note\nCough improved\nContinue inhaler as advised\nReturn if breathless"),
    ("doc-en-011", "Blood Pressure Log\nWeek 1: 150/95\nWeek 2: 145/90\nWeek 3: 138/86\nMedicine taken daily"),
    ("doc-en-012", "Growth Chart\nWeight: 8.4 kg\nHeight: 74 cm\nAge: 12 months\nFully immunized"),
]

HINDI_DOCUMENTS: list[tuple[str, str]] = [
    ("doc-hi-001", "निदान: बुखार\nदवा: पैरासिटामोल\nसात दिन बाद आएं"),
    ("doc-hi-002", "रिपोर्ट\nहीमोग्लोबिन कम है\nआयरन की गोली दी गई"),
    ("doc-hi-003", "टीकाकरण पंजिका\nबीसीजी दिया गया\nअगला टीका छह हफ्ते बाद"),
]

SAPI_SCRIPT = """
Add-Type -AssemblyName System.Speech
$voice = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voice.SetOutputToWaveFile('{wav}')
$voice.Rate = -1
$voice.Speak('{text}')
$voice.Dispose()
"""


def synthesize_speech() -> list[dict]:
    """Best effort: synthesizes English entries where SAPI has a voice."""
    SPEECH_DIR.mkdir(parents=True, exist_ok=True)
    rows: list[dict] = []
    for identifier, text in ENGLISH_DICTATIONS:
        wav = SPEECH_DIR / f"{identifier}.wav"
        if wav.exists():
            status = "ok"
        else:
            result = subprocess.run(
                [
                    "powershell",
                    "-NoProfile",
                    "-Command",
                    SAPI_SCRIPT.format(wav=str(wav), text=text.replace("'", "''")),
                ],
                capture_output=True,
                text=True,
            )
            status = "ok" if result.returncode == 0 and wav.exists() else "synthesis-failed"
        rows.append(
            {
                "id": identifier,
                "file": f"{identifier}.wav",
                "language": "en",
                "reference_transcript": text,
                "status": status,
            }
        )
    for identifier, text in HINDI_DICTATIONS:
        rows.append(
            {
                "id": identifier,
                "file": f"{identifier}.wav",
                "language": "hi",
                "reference_transcript": text,
                # No Hindi SAPI voice on stock Windows: a human records these
                # once, or a Hindi TTS voice is installed and the flag flips.
                "status": "record-manually",
            }
        )
    return rows


def _load_font(size: int, hindi: bool) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = ["Nirmala.ttf", "Mangal.ttf"] if hindi else ["arial.ttf", "Arial.ttf"]
    for name in candidates:
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def render_documents() -> list[dict]:
    """Renders the printed-document golden set with exact reference text."""
    DOCUMENTS_DIR.mkdir(parents=True, exist_ok=True)
    rows: list[dict] = []
    for identifier, text in ENGLISH_DOCUMENTS:
        rows.append(_render_document(identifier, text, hindi=False))
    for identifier, text in HINDI_DOCUMENTS:
        rows.append(_render_document(identifier, text, hindi=True))
    return rows


def _render_document(identifier: str, text: str, hindi: bool) -> dict:
    image = Image.new("RGB", (900, 500), "white")
    draw = ImageDraw.Draw(image)
    font = _load_font(34, hindi=hindi)
    draw.text((60, 60), text, fill=(20, 20, 20), font=font, spacing=18)
    path = DOCUMENTS_DIR / f"{identifier}.png"
    image.save(path)
    return {
        "id": identifier,
        "file": f"{identifier}.png",
        "language": "hi" if hindi else "en",
        "reference_text": text,
        "kind": "printed",
        "status": "ok",
    }


def main() -> None:
    speech_rows = synthesize_speech()
    document_rows = render_documents()

    SPEECH_DIR.mkdir(parents=True, exist_ok=True)
    with (SPEECH_DIR / "manifest.jsonl").open("w", encoding="utf-8") as handle:
        for row in speech_rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")

    with (DOCUMENTS_DIR / "manifest.jsonl").open("w", encoding="utf-8") as handle:
        for row in document_rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")

    # Expected facts per source, for extraction precision/recall. Kept to
    # facts explicitly stated in the reference text or transcript, matching
    # the extraction contract ("explicit facts only").
    extraction_rows = [
        {
            "id": "facts-en-001",
            "source_id": "en-004",
            "expected_facts": [
                {"category": "medication", "value": "paracetamol 500 mg"},
                {"category": "other", "value": "three times a day"},
            ],
        },
        {
            "id": "facts-en-002",
            "source_id": "en-005",
            "expected_facts": [
                {"category": "allergy", "value": "penicillin"},
                {"category": "symptom", "value": "rash"},
            ],
        },
        {
            "id": "facts-en-003",
            "source_id": "doc-en-003",
            "expected_facts": [
                {"category": "measurement", "value": "10.2"},
                {"category": "measurement", "value": "110"},
                {"category": "measurement", "value": "178"},
            ],
        },
        {
            "id": "facts-en-004",
            "source_id": "doc-en-007",
            "expected_facts": [
                {"category": "measurement", "value": "92"},
                {"category": "measurement", "value": "140/90"},
                {"category": "measurement", "value": "100.2"},
            ],
        },
        {
            "id": "facts-hi-001",
            "source_id": "hi-003",
            "expected_facts": [
                {"category": "medication", "value": "पैरासिटामोल"},
                {"category": "other", "value": "दिन में तीन बार"},
            ],
            "status": "record-manually",
        },
    ]
    EXTRACTION_DIR.mkdir(parents=True, exist_ok=True)
    with (EXTRACTION_DIR / "manifest.jsonl").open("w", encoding="utf-8") as handle:
        for row in extraction_rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")

    synthesized = sum(1 for row in speech_rows if row["status"] == "ok")
    print(f"speech: {len(speech_rows)} manifest rows, {synthesized} synthesized here")
    print(f"documents: {len(document_rows)} rendered")
    print(f"extraction: {len(extraction_rows)} fact rows")
    print(f"golden set root: {GOLDEN_DIR}")


if __name__ == "__main__":
    main()
