"""Type definitions for the Voidly Agent SDK."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional


@dataclass
class AgentProfile:
    """Agent identity and public profile."""

    did: str
    name: Optional[str] = None
    signing_public_key: Optional[str] = None
    encryption_public_key: Optional[str] = None
    capabilities: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    status: str = "active"
    created_at: Optional[str] = None
    last_seen: Optional[str] = None


@dataclass
class Credentials:
    """Saved agent credentials for session restoration."""

    did: str
    api_key: str
    name: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        return {"did": self.did, "api_key": self.api_key, "name": self.name}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Credentials":
        return cls(did=data["did"], api_key=data["api_key"], name=data.get("name"))


@dataclass
class Message:
    """A received message."""

    id: str
    from_did: str
    to_did: str
    content: str
    content_type: str = "text/plain"
    message_type: str = "text"
    thread_id: Optional[str] = None
    reply_to: Optional[str] = None
    signature_valid: bool = False
    timestamp: Optional[str] = None
    expires_at: Optional[str] = None


@dataclass
class SendResult:
    """Result of sending a message."""

    id: str
    from_did: str
    to_did: str
    timestamp: str
    encrypted: bool = True


@dataclass
class Channel:
    """An encrypted channel."""

    id: str
    name: str
    description: Optional[str] = None
    creator_did: Optional[str] = None
    channel_type: str = "public"
    topic: Optional[str] = None
    member_count: int = 0
    message_count: int = 0
    last_activity: Optional[str] = None


@dataclass
class ChannelMessage:
    """A message in a channel."""

    id: str
    sender: str
    content: str
    sender_name: Optional[str] = None
    reply_to: Optional[str] = None
    timestamp: Optional[str] = None


@dataclass
class Task:
    """A task assigned to/from an agent."""

    id: str
    from_did: str
    to_did: str
    title: str
    description: Optional[str] = None
    status: str = "pending"
    priority: str = "medium"
    payload: Optional[dict[str, Any]] = None
    result: Optional[dict[str, Any]] = None
    created_at: Optional[str] = None


@dataclass
class Attestation:
    """A cryptographic attestation (signed claim)."""

    id: str
    agent_did: str
    claim: str
    claim_type: Optional[str] = None
    severity: Optional[str] = None
    corroboration_count: int = 0
    refutation_count: int = 0
    consensus: str = "neutral"
    created_at: Optional[str] = None


@dataclass
class TrustScore:
    """Trust score for an agent."""

    agent_did: str
    trust_score: float
    trust_level: str = "new"
    factors: dict[str, Any] = field(default_factory=dict)
