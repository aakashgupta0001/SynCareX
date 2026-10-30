from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class ClinicKeyWrapIn(BaseModel):
    """
    A clinic data key wrapped for one user.

    Everything here is opaque to the server. `wrapped_key` is AES-GCM
    ciphertext produced on a device; the server stores and returns it without
    ever holding the key that opens it.
    """

    user_id: UUID
    key_epoch: int = Field(default=1, ge=1, le=1_000_000)
    wrapped_key: str = Field(min_length=16, max_length=512)
    wrap_iv: str = Field(min_length=8, max_length=64)
    kdf_salt: str = Field(min_length=8, max_length=64)
    kdf_iterations: int = Field(ge=100_000, le=10_000_000)


class ClinicKeyPublishRequest(BaseModel):
    """
    Publishes the wraps for a clinic's key. One entry per user who should be
    able to open it, produced together on the device that generated the key.
    """

    wraps: list[ClinicKeyWrapIn] = Field(min_length=1, max_length=200)


class ClinicKeyWrapRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    clinic_id: UUID
    user_id: UUID
    key_epoch: int
    wrapped_key: str
    wrap_iv: str
    kdf_salt: str
    kdf_iterations: int
    created_at: datetime


class ClinicKeyStatus(BaseModel):
    """Whether a clinic key exists, without revealing any key material."""

    clinic_id: UUID
    key_epoch: int | None
    wrapped_for_this_user: bool
    user_count_with_access: int
    # States plainly that holding a key does not mean records are encrypted.
    records_encrypted: bool = False
