from uuid import UUID

from pydantic import BaseModel, ConfigDict, EmailStr, Field


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=256)


class RoleRead(BaseModel):
    name: str
    permissions: list[str]


class UserRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    clinic_id: UUID
    email: EmailStr
    full_name: str
    roles: list[RoleRead]


class AuthResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserRead
