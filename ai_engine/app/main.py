import asyncio
import hmac
import logging
import shutil
from typing import Annotated

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import uvicorn

from .catalog import MODEL_BY_ID
from .config import Settings, get_settings
from .model_manager import ModelInstallError, download_model
from .models import EngineStatus, ExtractionResult, ModelStatus, OCRResult, TranscriptionResult
from .providers import ProviderUnavailable, extract_facts, ocr, transcribe
from .readiness import all_model_statuses, build_status, model_status

logger = logging.getLogger("syncarex.ai")


def create_app(settings: Settings | None = None) -> FastAPI:
    config = settings or get_settings()
    app = FastAPI(
        title="SynCareX Local AI Engine",
        description=(
            "Optional loopback-only AI adapters. Generated content is unverified "
            "and requires authorized clinician review."
        ),
        version="0.1.0",
        docs_url="/docs",
    )
    app.state.settings = config
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(config.allowed_origins),
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
    )

    def require_token(
        authorization: Annotated[str | None, Header()] = None,
    ) -> None:
        if not config.api_token:
            raise HTTPException(
                status_code=503,
                detail="Set SYNCAREX_AI_TOKEN before using protected local AI features.",
            )
        supplied = authorization.removeprefix("Bearer ").strip() if authorization else ""
        if not hmac.compare_digest(supplied, config.api_token):
            raise HTTPException(status_code=401, detail="Invalid local AI engine token.")

    @app.exception_handler(ProviderUnavailable)
    async def provider_error_handler(_, error: ProviderUnavailable) -> JSONResponse:
        return JSONResponse(status_code=503, content={"detail": str(error)})

    @app.exception_handler(ModelInstallError)
    async def model_install_error_handler(_, error: ModelInstallError) -> JSONResponse:
        return JSONResponse(status_code=502, content={"detail": str(error)})

    @app.get("/health", tags=["health"])
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/v1/status", response_model=EngineStatus, tags=["readiness"])
    def status() -> EngineStatus:
        try:
            return build_status(config)
        except OSError as error:
            logger.exception("Could not inspect local AI readiness")
            raise HTTPException(status_code=500, detail="Could not inspect local AI readiness.") from error

    @app.get("/api/v1/models", response_model=list[ModelStatus], tags=["models"])
    def models() -> list[ModelStatus]:
        try:
            return all_model_statuses(config)
        except OSError as error:
            logger.exception("Could not inspect local AI models")
            raise HTTPException(status_code=500, detail="Could not inspect local AI models.") from error

    @app.post(
        "/api/v1/models/{model_id}/download",
        response_model=ModelStatus,
        dependencies=[Depends(require_token)],
        tags=["models"],
    )
    async def install_model(model_id: str) -> ModelStatus:
        spec = MODEL_BY_ID.get(model_id)
        if not spec:
            raise HTTPException(status_code=404, detail="Model is not in the verified catalog.")
        try:
            config.model_dir.mkdir(parents=True, exist_ok=True)
            available_disk = shutil.disk_usage(config.model_dir).free
        except OSError as error:
            logger.exception("Could not inspect model storage")
            raise HTTPException(
                status_code=500,
                detail="Could not inspect the configured model storage.",
            ) from error
        if available_disk < spec.size_bytes + 16 * 1024 * 1024:
            raise HTTPException(
                status_code=507,
                detail="Not enough free disk space for this model and a safe installation margin.",
            )
        try:
            await asyncio.to_thread(download_model, spec, config.model_dir)
            status_now = build_status(config)
            return model_status(spec, config, status_now)
        except ModelInstallError as error:
            raise HTTPException(status_code=502, detail=str(error)) from error

    @app.post(
        "/api/v1/transcriptions",
        response_model=TranscriptionResult,
        dependencies=[Depends(require_token)],
        tags=["transcription"],
    )
    async def create_transcription(
        model_id: Annotated[str, Form()],
        language: Annotated[str, Form()] = "auto",
        task: Annotated[str, Form()] = "transcribe",
        audio: UploadFile = File(...),
    ) -> TranscriptionResult:
        if task not in {"transcribe", "translate"}:
            raise HTTPException(
                status_code=422,
                detail="task must be 'transcribe' or 'translate'.",
            )
        content = await audio.read(config.max_upload_bytes + 1)
        await audio.close()
        try:
            return await asyncio.to_thread(
                transcribe,
                config,
                model_id,
                language,
                audio.filename or "",
                content,
                task,
            )
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @app.post(
        "/api/v1/ocr",
        response_model=OCRResult,
        dependencies=[Depends(require_token)],
        tags=["ocr"],
    )
    async def read_document(
        language: Annotated[str, Form()] = "eng",
        document: UploadFile = File(...),
    ) -> OCRResult:
        content = await document.read(config.max_upload_bytes + 1)
        await document.close()
        try:
            return await asyncio.to_thread(
                ocr,
                config,
                document.filename or "",
                language,
                content,
            )
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @app.post(
        "/api/v1/extractions",
        response_model=ExtractionResult,
        dependencies=[Depends(require_token)],
        tags=["extraction"],
    )
    async def create_extraction(
        model_id: Annotated[str, Form()],
        source_text: Annotated[str, Form()],
    ) -> ExtractionResult:
        try:
            return await asyncio.to_thread(extract_facts, config, model_id, source_text)
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    return app


app = create_app()


if __name__ == "__main__":
    if not app.state.settings.api_token:
        raise SystemExit(
            "SYNCAREX_AI_TOKEN is required. Set it before starting the local AI service."
        )
    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="info")
