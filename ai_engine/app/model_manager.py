import hashlib
import os
from pathlib import Path
import tempfile
from urllib.request import Request, urlopen

from .catalog import ModelSpec


class ModelInstallError(Exception):
    pass


def verify_model(path: Path, spec: ModelSpec) -> None:
    if not path.is_file() or path.stat().st_size != spec.size_bytes:
        raise ModelInstallError(f"Model file size does not match the catalog for {spec.model_id}.")
    digest = hashlib.sha256()
    with path.open("rb") as model_file:
        for chunk in iter(lambda: model_file.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != spec.sha256:
        raise ModelInstallError(f"Model SHA-256 verification failed for {spec.model_id}.")


def download_model(spec: ModelSpec, model_dir: Path) -> Path:
    model_dir.mkdir(parents=True, exist_ok=True)
    destination = model_dir / spec.filename
    if destination.exists():
        verify_model(destination, spec)
        return destination

    digest = hashlib.sha256()
    size = 0
    temp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb",
            prefix=f".{spec.model_id}-",
            suffix=".part",
            dir=model_dir,
            delete=False,
        ) as temp_file:
            temp_path = Path(temp_file.name)
            request = Request(spec.url, headers={"User-Agent": "SynCareX-local-ai/1.0"})
            with urlopen(request, timeout=30) as response:
                final_url = response.geturl()
                if not final_url.startswith("https://"):
                    raise ModelInstallError("The model source did not use HTTPS.")
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > spec.size_bytes:
                        raise ModelInstallError("Downloaded model exceeds the catalog size limit.")
                    digest.update(chunk)
                    temp_file.write(chunk)
            temp_file.flush()
            os.fsync(temp_file.fileno())

        if size != spec.size_bytes:
            raise ModelInstallError(
                f"Downloaded size mismatch: expected {spec.size_bytes} bytes, got {size}."
            )
        if digest.hexdigest() != spec.sha256:
            raise ModelInstallError("Downloaded model SHA-256 does not match the trusted catalog.")
        os.replace(temp_path, destination)
        temp_path = None
        return destination
    except ModelInstallError:
        raise
    except OSError as error:
        raise ModelInstallError(f"Model download failed: {error}") from error
    finally:
        if temp_path and temp_path.exists():
            temp_path.unlink()
