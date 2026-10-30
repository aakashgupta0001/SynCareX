from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

EntityType = Literal[
    "patient",
    "patientIdentifier",
    "consultation",
    "clinicalNote",
    "observation",
    "allergy",
    "medication",
    "document",
    "referral",
    "followup",
    "passport",
]
OperationType = Literal["create", "update", "archive", "upload"]


class SealedContent(BaseModel):
    """
    Content encrypted with the clinic key. The server stores these fields and
    cannot read them; during dual-write the plaintext payload is still what
    readers use.
    """

    ciphertext: str = Field(min_length=16, max_length=200_000)
    iv: str = Field(min_length=8, max_length=64)
    key_epoch: int = Field(ge=1, le=1_000_000)

class SyncOperationIn(BaseModel):
    """One queued device operation."""

    operation_id: UUID
    # Deterministic SHA-256 hex produced by the device for this exact change.
    idempotency_key: str = Field(min_length=32, max_length=64, pattern=r"^[0-9a-f]+$")
    actor_id: UUID | None = None
    device_id: str | None = Field(default=None, min_length=8, max_length=64)
    schema_version: int = Field(default=1, ge=1, le=10)
    entity_type: EntityType
    entity_id: UUID
    operation_type: OperationType
    base_version: int = Field(ge=0)
    local_version: int = Field(ge=1)
    payload: dict[str, Any] = Field(default_factory=dict)
    # Dual-write: the same content sealed with the clinic key. Optional,
    # because a device without a clinic key still synchronizes normally.
    sealed_content: SealedContent | None = None
    # Keyed hashes of this record's searchable trigrams, so the server can
    # match searches without reading the terms.
    search_terms: list[str] = Field(default_factory=list, max_length=4000)
    created_at: datetime | None = None


class SyncBatchRequest(BaseModel):
    device_id: str = Field(min_length=8, max_length=64)
    operations: list[SyncOperationIn] = Field(min_length=1, max_length=500)


class SyncOperationResult(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    operation_id: UUID
    idempotency_key: str
    entity_type: str
    entity_id: UUID
    status: Literal["acknowledged", "conflict", "rejected"]
    # True when this exact operation had already been applied.
    duplicate: bool = False
    # False means retrying unchanged cannot succeed.
    retryable: bool = False
    server_version: int | None = None
    message: str | None = None
    entity: dict[str, Any] | None = None


class SyncBatchResponse(BaseModel):
    results: list[SyncOperationResult]
    server_time: datetime
    acknowledged: int
    conflicts: int
    rejected: int


class SyncChangeRead(BaseModel):
    cursor: int
    operation_id: UUID | None
    entity_type: str
    entity_id: UUID
    operation_type: str
    entity_version: int
    payload: dict[str, Any]
    tombstone: bool
    created_at: datetime


class SyncPullResponse(BaseModel):
    changes: list[SyncChangeRead]
    next_cursor: int
    has_more: bool


class DeviceProvisionRequest(BaseModel):
    device_id: str = Field(min_length=8, max_length=64)
    label: str = Field(default="Browser", max_length=120)


class DeviceProvisionResponse(BaseModel):
    device_id: str
    server_device_id: UUID
    status: str
    offline_grace_days: int
    provisioned_at: datetime
