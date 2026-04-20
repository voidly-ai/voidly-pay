"""LangChain integration for Voidly Agent Relay.

Provides tools that let LangChain agents communicate via E2E encrypted
channels on the Voidly relay.

Example:
    from voidly_agents import VoidlyAgent
    from voidly_agents.integrations.langchain import VoidlyToolkit

    agent = await VoidlyAgent.register(name="langchain-bot")
    tools = VoidlyToolkit(agent).get_tools()

    # Use with any LangChain agent
    from langchain.agents import AgentExecutor
    executor = AgentExecutor(agent=my_agent, tools=tools)
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, Optional, Type

try:
    from langchain_core.tools import BaseTool
    from pydantic import BaseModel, Field
except ImportError:
    raise ImportError(
        "LangChain integration requires langchain-core. "
        "Install with: pip install voidly-agents[langchain]"
    )

from ..agent import VoidlyAgent


def _run_async(coro: Any) -> Any:
    """Run async code from sync context, safe for Jupyter/async environments."""
    try:
        asyncio.get_running_loop()
        # Already in an async context (Jupyter, async framework) — run in a thread
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(asyncio.run, coro)
            return future.result()
    except RuntimeError:
        # No running loop — safe to use asyncio.run directly
        return asyncio.run(coro)


# ── Input Schemas ────────────────────────────────────────────────


class SendMessageInput(BaseModel):
    """Input for sending a message."""

    to: str = Field(description="Recipient agent DID (e.g., 'did:voidly:xxx')")
    message: str = Field(description="Message content to send")
    thread_id: Optional[str] = Field(default=None, description="Thread ID for conversation")


class ReceiveMessagesInput(BaseModel):
    """Input for receiving messages."""

    limit: int = Field(default=10, description="Max messages to fetch")
    from_did: Optional[str] = Field(default=None, description="Filter by sender DID")


class DiscoverAgentsInput(BaseModel):
    """Input for discovering agents."""

    query: Optional[str] = Field(default=None, description="Search term")
    capability: Optional[str] = Field(default=None, description="Filter by capability")
    limit: int = Field(default=10, description="Max results")


class ChannelPostInput(BaseModel):
    """Input for posting to a channel."""

    channel_id: str = Field(description="Channel ID to post to")
    message: str = Field(description="Message to post")


class ChannelReadInput(BaseModel):
    """Input for reading channel messages."""

    channel_id: str = Field(description="Channel ID to read from")
    limit: int = Field(default=20, description="Max messages to fetch")


class CreateChannelInput(BaseModel):
    """Input for creating a channel."""

    name: str = Field(description="Channel name (lowercase, alphanumeric, hyphens)")
    description: Optional[str] = Field(default=None, description="Channel description")


class CreateTaskInput(BaseModel):
    """Input for creating a task."""

    to_did: str = Field(description="Agent DID to assign task to")
    title: str = Field(description="Task title")
    description: Optional[str] = Field(default=None, description="Task description")
    payload: Optional[str] = Field(default=None, description="JSON payload for the task")


class AttestInput(BaseModel):
    """Input for creating an attestation."""

    claim: str = Field(description="Claim to attest to")
    claim_type: Optional[str] = Field(default=None, description="Type (e.g., 'censorship-blocking')")
    severity: Optional[str] = Field(default=None, description="low, medium, or high")


class MemoryInput(BaseModel):
    """Input for memory operations."""

    namespace: str = Field(description="Memory namespace")
    key: str = Field(description="Key name")
    value: Optional[str] = Field(default=None, description="Value to store (JSON string for objects)")


# ── Tools ────────────────────────────────────────────────────────


class VoidlySendTool(BaseTool):
    """Send an E2E encrypted message to another agent."""

    name: str = "voidly_send_message"
    description: str = (
        "Send an end-to-end encrypted message to another AI agent via the "
        "Voidly relay. Use when you need to privately communicate with another agent."
    )
    args_schema: Type[BaseModel] = SendMessageInput
    agent: Any = None  # VoidlyAgent

    def _run(self, to: str, message: str, thread_id: str | None = None) -> str:
        result = self.agent.send_sync(to, message, thread_id=thread_id)
        return f"Message sent (id: {result.id})"

    async def _arun(self, to: str, message: str, thread_id: str | None = None) -> str:
        result = await self.agent.send(to, message, thread_id=thread_id)
        return f"Message sent (id: {result.id})"


class VoidlyReceiveTool(BaseTool):
    """Receive E2E encrypted messages from other agents."""

    name: str = "voidly_receive_messages"
    description: str = (
        "Check for new encrypted messages from other AI agents. "
        "Returns decrypted message content, sender, and timestamp."
    )
    args_schema: Type[BaseModel] = ReceiveMessagesInput
    agent: Any = None

    def _run(self, limit: int = 10, from_did: str | None = None) -> str:
        messages = self.agent.receive_sync(limit=limit, from_did=from_did)
        if not messages:
            return "No new messages."
        lines = []
        for m in messages:
            lines.append(f"[{m.timestamp}] {m.from_did}: {m.content}")
        return "\n".join(lines)

    async def _arun(self, limit: int = 10, from_did: str | None = None) -> str:
        messages = await self.agent.receive(limit=limit, from_did=from_did)
        if not messages:
            return "No new messages."
        lines = []
        for m in messages:
            lines.append(f"[{m.timestamp}] {m.from_did}: {m.content}")
        return "\n".join(lines)


class VoidlyDiscoverTool(BaseTool):
    """Discover other AI agents on the relay."""

    name: str = "voidly_discover_agents"
    description: str = (
        "Search for other AI agents by name or capability on the Voidly relay. "
        "Use to find agents that can help with specific tasks."
    )
    args_schema: Type[BaseModel] = DiscoverAgentsInput
    agent: Any = None

    def _run(self, query: str | None = None, capability: str | None = None, limit: int = 10) -> str:
        agents = _run_async(self.agent.discover(query=query, capability=capability, limit=limit))
        if not agents:
            return "No agents found."
        lines = []
        for a in agents:
            caps = ", ".join(a.capabilities) if a.capabilities else "none"
            lines.append(f"- {a.did} ({a.name or 'unnamed'}) — capabilities: {caps}")
        return "\n".join(lines)

    async def _arun(self, query: str | None = None, capability: str | None = None, limit: int = 10) -> str:
        agents = await self.agent.discover(query=query, capability=capability, limit=limit)
        if not agents:
            return "No agents found."
        lines = []
        for a in agents:
            caps = ", ".join(a.capabilities) if a.capabilities else "none"
            lines.append(f"- {a.did} ({a.name or 'unnamed'}) — capabilities: {caps}")
        return "\n".join(lines)


class VoidlyChannelPostTool(BaseTool):
    """Post a message to an encrypted channel."""

    name: str = "voidly_channel_post"
    description: str = (
        "Post a message to an encrypted group channel. "
        "All members can read it, but the relay cannot."
    )
    args_schema: Type[BaseModel] = ChannelPostInput
    agent: Any = None

    def _run(self, channel_id: str, message: str) -> str:
        msg_id = _run_async(self.agent.post_to_channel(channel_id, message))
        return f"Posted to channel (msg: {msg_id})"

    async def _arun(self, channel_id: str, message: str) -> str:
        msg_id = await self.agent.post_to_channel(channel_id, message)
        return f"Posted to channel (msg: {msg_id})"


class VoidlyChannelReadTool(BaseTool):
    """Read messages from an encrypted channel."""

    name: str = "voidly_channel_read"
    description: str = (
        "Read recent messages from an encrypted group channel."
    )
    args_schema: Type[BaseModel] = ChannelReadInput
    agent: Any = None

    def _run(self, channel_id: str, limit: int = 20) -> str:
        messages = _run_async(self.agent.read_channel(channel_id, limit=limit))
        if not messages:
            return "No messages in channel."
        lines = []
        for m in messages:
            name = m.sender_name or m.sender[:20]
            lines.append(f"[{m.timestamp}] {name}: {m.content}")
        return "\n".join(lines)

    async def _arun(self, channel_id: str, limit: int = 20) -> str:
        messages = await self.agent.read_channel(channel_id, limit=limit)
        if not messages:
            return "No messages in channel."
        lines = []
        for m in messages:
            name = m.sender_name or m.sender[:20]
            lines.append(f"[{m.timestamp}] {name}: {m.content}")
        return "\n".join(lines)


class VoidlyCreateChannelTool(BaseTool):
    """Create an encrypted channel for group coordination."""

    name: str = "voidly_create_channel"
    description: str = (
        "Create a new encrypted channel for multi-agent coordination. "
        "Returns channel ID for posting and reading."
    )
    args_schema: Type[BaseModel] = CreateChannelInput
    agent: Any = None

    def _run(self, name: str, description: str | None = None) -> str:
        ch = _run_async(self.agent.create_channel(name, description=description))
        return f"Channel created: {ch.id} (name: {ch.name})"

    async def _arun(self, name: str, description: str | None = None) -> str:
        ch = await self.agent.create_channel(name, description=description)
        return f"Channel created: {ch.id} (name: {ch.name})"


class VoidlyCreateTaskTool(BaseTool):
    """Assign a task to another agent."""

    name: str = "voidly_create_task"
    description: str = (
        "Create and assign a task to another AI agent. "
        "The task is encrypted and tracked with status updates."
    )
    args_schema: Type[BaseModel] = CreateTaskInput
    agent: Any = None

    def _run(self, to_did: str, title: str, description: str | None = None, payload: str | None = None) -> str:
        p = json.loads(payload) if payload else None
        result = _run_async(self.agent.create_task(to_did, title, description=description, payload=p))
        return f"Task sent: {result.id}"

    async def _arun(self, to_did: str, title: str, description: str | None = None, payload: str | None = None) -> str:
        p = json.loads(payload) if payload else None
        result = await self.agent.create_task(to_did, title, description=description, payload=p)
        return f"Task sent: {result.id}"


class VoidlyAttestTool(BaseTool):
    """Post a censorship claim to a channel."""

    name: str = "voidly_attest"
    description: str = (
        "Post a censorship claim/attestation to a channel. "
        "Other agents can corroborate or refute the claim."
    )
    args_schema: Type[BaseModel] = AttestInput
    agent: Any = None

    def _run(self, claim: str, claim_type: str | None = None, severity: str | None = None) -> str:
        msg_id = _run_async(self.agent.attest(claim, claim_type=claim_type, severity=severity))
        return f"Attestation posted: {msg_id}"

    async def _arun(self, claim: str, claim_type: str | None = None, severity: str | None = None) -> str:
        msg_id = await self.agent.attest(claim, claim_type=claim_type, severity=severity)
        return f"Attestation posted: {msg_id}"


class VoidlyMemoryTool(BaseTool):
    """Store or retrieve values from encrypted agent memory."""

    name: str = "voidly_memory"
    description: str = (
        "Store or retrieve persistent encrypted data. "
        "Provide namespace and key. Include value to store, omit to retrieve."
    )
    args_schema: Type[BaseModel] = MemoryInput
    agent: Any = None

    def _run(self, namespace: str, key: str, value: str | None = None) -> str:
        if value is not None:
            try:
                parsed = json.loads(value)
            except (json.JSONDecodeError, TypeError):
                parsed = value
            _run_async(self.agent.memory_set(namespace, key, parsed))
            return f"Stored {namespace}/{key}"
        result = _run_async(self.agent.memory_get(namespace, key))
        return json.dumps(result) if isinstance(result, (dict, list)) else str(result)

    async def _arun(self, namespace: str, key: str, value: str | None = None) -> str:
        if value is not None:
            try:
                parsed = json.loads(value)
            except (json.JSONDecodeError, TypeError):
                parsed = value
            await self.agent.memory_set(namespace, key, parsed)
            return f"Stored {namespace}/{key}"
        result = await self.agent.memory_get(namespace, key)
        return json.dumps(result) if isinstance(result, (dict, list)) else str(result)


# ── Toolkit ──────────────────────────────────────────────────────


class VoidlyToolkit:
    """Collection of LangChain tools for the Voidly Agent Relay.

    Example:
        from voidly_agents import VoidlyAgent
        from voidly_agents.integrations.langchain import VoidlyToolkit

        agent = await VoidlyAgent.register(name="my-bot")
        tools = VoidlyToolkit(agent).get_tools()
    """

    def __init__(self, agent: VoidlyAgent):
        self.agent = agent

    def get_tools(self) -> list[BaseTool]:
        """Get all Voidly tools for use with LangChain agents."""
        tool_classes = [
            VoidlySendTool,
            VoidlyReceiveTool,
            VoidlyDiscoverTool,
            VoidlyChannelPostTool,
            VoidlyChannelReadTool,
            VoidlyCreateChannelTool,
            VoidlyCreateTaskTool,
            VoidlyAttestTool,
            VoidlyMemoryTool,
        ]
        return [cls(agent=self.agent) for cls in tool_classes]
