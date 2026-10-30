from dataclasses import dataclass


@dataclass(frozen=True)
class ModelSpec:
    model_id: str
    name: str
    task: str
    filename: str
    url: str
    size_bytes: int
    sha256: str
    minimum_free_ram_mb: int
    runtime: str
    languages: tuple[str, ...]
    license: str


MODELS = (
    ModelSpec(
        model_id="whisper-tiny",
        name="Whisper tiny (multilingual)",
        task="transcription",
        filename="ggml-tiny.bin",
        url="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin",
        size_bytes=77_691_713,
        sha256="be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21",
        minimum_free_ram_mb=2_048,
        runtime="whisper.cpp",
        languages=("Hindi", "English", "multilingual"),
        license="MIT",
    ),
    ModelSpec(
        model_id="whisper-base",
        name="Whisper base (multilingual)",
        task="transcription",
        filename="ggml-base.bin",
        url="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
        size_bytes=147_951_465,
        sha256="60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
        minimum_free_ram_mb=3_072,
        runtime="whisper.cpp",
        languages=("Hindi", "English", "multilingual"),
        license="MIT",
    ),
    ModelSpec(
        model_id="whisper-small",
        name="Whisper small (multilingual)",
        task="transcription",
        filename="ggml-small.bin",
        url="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
        size_bytes=487_601_967,
        sha256="1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
        minimum_free_ram_mb=6_144,
        runtime="whisper.cpp",
        languages=("Hindi", "English", "multilingual"),
        license="MIT",
    ),
    ModelSpec(
        model_id="qwen-0.5b-q4",
        name="Qwen 2.5 0.5B Instruct Q4_K_M",
        task="structured-extraction",
        filename="Qwen2.5-0.5B-Instruct-Q4_K_M.gguf",
        url=(
            "https://huggingface.co/bartowski/Qwen2.5-0.5B-Instruct-GGUF/"
            "resolve/main/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf"
        ),
        size_bytes=397_808_192,
        sha256="6eb923e7d26e9cea28811e1a8e852009b21242fb157b26149d3b188f3a8c8653",
        minimum_free_ram_mb=4_096,
        runtime="llama.cpp",
        languages=("Hindi", "English", "multilingual"),
        license="Apache-2.0",
    ),
)

MODEL_BY_ID = {model.model_id: model for model in MODELS}
