from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator


class ClinicKeyWrapIn(BaseModel):
    """
    A clinic data key wrapped for one user.

    Everything here is opaque to the server. `wrapped_key` is AES-GCM
    ciphertext produced on a device; the server stores and returns it without
    ever holding the key that opens it.

    Two wrap types exist:
    - `passphrase`: the holder derived the wrapping key from the recipient's
      passphrase. Requires the PBKDF2 salt and iteration count.
    - `identity`: the holder sealed the key to the recipient's published
      identity public key with an ephemeral ECDH key. Requires
      `ephemeral_public_key`; the PBKDF2 fields are not used.
    """

    user_id: UUID
    key_epoch: int = Field(default=1, ge=1, le=1_000_000)
    wrapped_key: str = Field(min_length=16, max_length=512)
    wrap_iv: str = Field(min_length=8, max_length=64)
    wrap_type: Literal["passphrase", "identity"] = "passphrase"
    kdf_salt: str = Field(default="", max_length=64)
    kdf_iterations: int = Field(default=310_000, ge=100_000, le=10_000_000)
    ephemeral_public_key: str | None = Field(default=None, max_length=2_000)

    @model_validator(mode="after")
    def _check_fields_for_type(self) -> "ClinicKeyWrapIn":
        if self.wrap_type == "passphrase":
            if len(self.kdf_salt) < 8:
                raise ValueError("A passphrase wrap requires a kdf_salt.")
        else:
            if not self.ephemeral_public_key:
                raise ValueError(
                    "An identity wrap requires the ephemeral public key."
                )
        return self


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
    wrap_type: str = "passphrase"
    kdf_salt: str
    kdf_iterations: int
    ephemeral_public_key: str | None = None
    created_at: datetime


class ClinicKeyStatus(BaseModel):
    """Whether a clinic key exists, without revealing any key material."""

    clinic_id: UUID
    key_epoch: int | None
    wrapped_for_this_user: bool
    user_count_with_access: int
    # States plainly that holding a key does not mean records are encrypted.
    records_encrypted: bool = False


class IdentityKeyPublish(BaseModel):
    """The caller's ECDH P-256 public key, as a JSON Web Key string.

    The private half never leaves the device: it is generated there and
    encrypted under the local vault. Publishing a replacement is allowed —
    a clinician may re-provision a device — but it is audited, because every
    previously published wrap for this user becomes unreadable the moment a
    new key appears.
    """

    public_key: str = Field(min_length=40, max_length=2_000)


class IdentityKeyRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    user_id: UUID
    public_key: str
    created_at: datetime


class ClinicMemberRead(BaseModel):
    """A clinic member, for the share-the-key UI. No key material."""

    id: UUID
    email: str
    full_name: str
    holds_clinic_key: bool
    has_identity_key: bool
