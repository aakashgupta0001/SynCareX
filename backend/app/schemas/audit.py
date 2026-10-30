from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict


class AuditLogRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    actor_id: UUID
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
