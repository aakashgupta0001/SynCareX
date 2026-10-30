import ctypes
import importlib.util
import os
import platform
import shutil
import sys
from pathlib import Path

from .config import Settings
from .models import EngineStatus, ModelStatus, RuntimeStatus
from .catalog import MODELS, ModelSpec


def memory_mb() -> tuple[int, int]:
    if sys.platform == "win32":
        class MemoryStatus(ctypes.Structure):
            _fields_ = [
                ("length", ctypes.c_ulong),
                ("memory_load", ctypes.c_ulong),
                ("total_phys", ctypes.c_ulonglong),
                ("avail_phys", ctypes.c_ulonglong),
                ("total_page_file", ctypes.c_ulonglong),
                ("avail_page_file", ctypes.c_ulonglong),
                ("total_virtual", ctypes.c_ulonglong),
                ("avail_virtual", ctypes.c_ulonglong),
                ("avail_extended_virtual", ctypes.c_ulonglong),
            ]

        status = MemoryStatus()
        status.length = ctypes.sizeof(MemoryStatus)
        if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
            raise OSError("Windows could not report available memory.")
        return status.total_phys // (1024 * 1024), status.avail_phys // (1024 * 1024)

    if hasattr(os, "sysconf"):
        page_size = os.sysconf("SC_PAGE_SIZE")
        total = os.sysconf("SC_PHYS_PAGES") * page_size // (1024 * 1024)
        available = os.sysconf("SC_AVPHYS_PAGES") * page_size // (1024 * 1024)
        return total, available
    return 0, 0


def resolve_runtime(configured: str | None, executable: str) -> str | None:
    if configured:
        path = Path(configured).expanduser()
        if path.is_file():
            return str(path.resolve())
        return None
    return shutil.which(executable)


def list_tesseract_languages(binary: str | None) -> list[str]:
    if not binary:
        return []
    import subprocess

    result = subprocess.run(
        [binary, "--list-langs"],
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    if result.returncode:
        return []
    return [
        line.strip()
        for line in result.stdout.splitlines()
        if line.strip() and line.strip() != "List of available languages"
    ]


def runtime_paths(settings: Settings) -> dict[str, str | None]:
    llama_runtime = (
        "python:llama_cpp"
        if importlib.util.find_spec("llama_cpp") is not None
        else resolve_runtime(settings.llama_binary, "llama-cli")
    )
    return {
        "whisper": resolve_runtime(settings.whisper_binary, "whisper-cli"),
        "tesseract": resolve_runtime(settings.tesseract_binary, "tesseract"),
        "llama": llama_runtime,
        "ffmpeg": resolve_runtime(settings.ffmpeg_binary, "ffmpeg"),
        "pdftoppm": resolve_runtime(settings.pdftoppm_binary, "pdftoppm"),
        "pdfinfo": resolve_runtime(settings.pdfinfo_binary, "pdfinfo"),
    }


def build_status(settings: Settings) -> EngineStatus:
    total_ram_mb, available_ram_mb = memory_mb()
    settings.model_dir.mkdir(parents=True, exist_ok=True)
    free_disk_mb = shutil.disk_usage(settings.model_dir).free // (1024 * 1024)
    runtimes = runtime_paths(settings)
    return EngineStatus(
        ready=bool(settings.api_token),
        token_configured=bool(settings.api_token),
        operating_system=platform.platform(),
        processor=platform.processor() or "Not reported by operating system",
        logical_cores=os.cpu_count() or 0,
        accelerator_note="GPU capability is not detected or validated by this local engine.",
        model_directory=str(settings.model_dir),
        total_ram_mb=total_ram_mb,
        available_ram_mb=available_ram_mb,
        free_disk_mb=free_disk_mb,
        runtimes={
            "whisper": RuntimeStatus(available=bool(runtimes["whisper"]), executable=runtimes["whisper"]),
            "tesseract": RuntimeStatus(
                available=bool(runtimes["tesseract"]),
                executable=runtimes["tesseract"],
                languages=list_tesseract_languages(runtimes["tesseract"]),
            ),
            "llama": RuntimeStatus(available=bool(runtimes["llama"]), executable=runtimes["llama"]),
            "ffmpeg": RuntimeStatus(
                available=bool(runtimes["ffmpeg"]),
                executable=runtimes["ffmpeg"],
            ),
            "pdftoppm": RuntimeStatus(
                available=bool(runtimes["pdftoppm"]),
                executable=runtimes["pdftoppm"],
            ),
            "pdfinfo": RuntimeStatus(
                available=bool(runtimes["pdfinfo"]),
                executable=runtimes["pdfinfo"],
            ),
        },
    )


def model_status(spec: ModelSpec, settings: Settings, status: EngineStatus) -> ModelStatus:
    installed_path = settings.model_dir / spec.filename
    installed = installed_path.is_file() and installed_path.stat().st_size == spec.size_bytes
    runtime_key = {
        "whisper.cpp": "whisper",
        "llama.cpp": "llama",
    }.get(spec.runtime)
    runtime_available = (
        status.runtimes[runtime_key].available if runtime_key is not None else False
    )
    if not installed:
        reason = "Model is not installed."
    elif not runtime_available:
        reason = f"The {spec.runtime} runtime is not installed or configured."
    elif status.available_ram_mb < spec.minimum_free_ram_mb:
        reason = (
            f"Needs at least {spec.minimum_free_ram_mb} MiB free RAM; "
            f"{status.available_ram_mb} MiB is currently available."
        )
    else:
        reason = None
    return ModelStatus(
        id=spec.model_id,
        name=spec.name,
        task=spec.task,
        filename=spec.filename,
        size_bytes=spec.size_bytes,
        sha256=spec.sha256,
        minimum_free_ram_mb=spec.minimum_free_ram_mb,
        runtime=spec.runtime,
        languages=list(spec.languages),
        license=spec.license,
        installed=installed,
        compatible_now=reason is None,
        availability_reason=reason,
    )


def all_model_statuses(settings: Settings) -> list[ModelStatus]:
    status = build_status(settings)
    return [model_status(spec, settings, status) for spec in MODELS]
