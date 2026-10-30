from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict


class AuditLogRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    # Nullable since the patient portal: portal events are performed by a
    # patient, who is not a staff User.
    actor_id: UUID | None
    action: str
    entity_type: str
    entity_id: UUID | None
    outcome: str
    created_at: datetime


class AuditLogPage(BaseModel):
    items: list[AuditLogRead]
    page: int
    page_size: int
    total: int


class AuditVerifyResponse(BaseModel):
    """Result of walking the clinic's audit hash chain.

    ``valid`` is False when any row_hash fails recomputation, when a row's
    prev_hash does not match the previous row's row_hash, or when legacy
    rows without a hash exist after the chain started. ``first_broken`` is
    the id of the first offending row, so reviewers know where to look.
    """

    clinic_id: UUID
    checked: int
    valid: bool
    first_broken: UUID | None
    rows_without_hash: int
