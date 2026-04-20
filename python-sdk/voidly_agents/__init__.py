"""Voidly Agent SDK — E2E encrypted agent-to-agent communication."""

from .agent import VoidlyAgent
from .types import (
    AgentProfile,
    Message,
    SendResult,
    Channel,
    ChannelMessage,
    Task,
    Attestation,
    TrustScore,
)

__version__ = "0.1.0"
__all__ = [
    "VoidlyAgent",
    "AgentProfile",
    "Message",
    "SendResult",
    "Channel",
    "ChannelMessage",
    "Task",
    "Attestation",
    "TrustScore",
]
