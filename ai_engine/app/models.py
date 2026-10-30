from pydantic import BaseModel, Field


class RuntimeStatus(BaseModel):
    available: bool
    executable: str | None = None
    languages: list[str] = Field(default_factory=list)


class ModelStatus(BaseModel):
    id: str
    name: str
    task: str
    filename: str
    size_bytes: int
    sha256: str
    minimum_free_ram_mb: int
    runtime: str
    languages: list[str]
    license: str
    installed: bool
    compatible_now: bool
    availability_reason: str | None = None


class EngineStatus(BaseModel):
    ready: bool
    token_configured: bool
    operating_system: str
    processor: str
    logical_cores: int
    accelerator_note: str
    model_directory: str
    total_ram_mb: int
    available_ram_mb: int
    free_disk_mb: int
    runtimes: dict[str, RuntimeStatus]


class TranscriptionResult(BaseModel):
    text: str
    language: str
    model_id: str
    # "transcribe" keeps the spoken language; "translate" renders English.
    task: str = "transcribe"
    translated_to: str | None = None


class OCRResult(BaseModel):
    text: str
    language: str


class ExtractedFact(BaseModel):
    category: str = Field(pattern="^(symptom|allergy|medication|history|measurement|other)$")
    value: str = Field(min_length=1, max_length=500)
    evidence: str = Field(min_length=1, max_length=1_000)
    confidence: float = Field(ge=0, le=1)


class ExtractionResult(BaseModel):
    facts: list[ExtractedFact]
    model_id: str
    requires_review: bool = True


class SummaryRequest(BaseModel):
    model_id: str = Field(min_length=1, max_length=64)
    # The new visit: a transcript, OCR text or clinician-typed notes.
    new_source: str = Field(min_length=1, max_length=6_000)
    # Retrieved lines from the patient's existing local record.
    history: list[str] = Field(default_factory=list, max_length=60)


class SourceLine(BaseModel):
    id: str
    text: str


class SummaryItem(BaseModel):
    section: str = Field(
        pattern="^(presenting_complaint|relevant_history|medications|allergies|vitals)$"
    )
    text: str = Field(min_length=1, max_length=400)
    sources: list[str] = Field(min_length=1, max_length=12)
    # "ok": the wording and every number trace to the cited lines.
    # "check": they do not, so the clinician must verify against the source.
    support: str = Field(pattern="^(ok|check)$")


class SummaryResult(BaseModel):
    items: list[SummaryItem]
    source_lines: list[SourceLine]
    model_id: str
    # Statements the model returned without a valid line citation; never shown.
    dropped: int = 0
    requires_review: bool = True
