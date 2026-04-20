"""VoidlyAgent — Core SDK for the Voidly Agent Relay.

Uses server-side encryption endpoints for simplicity.
All messages are E2E encrypted by the relay using per-agent keypairs.

Example:
    agent = await VoidlyAgent.register(name="my-agent")
    await agent.send("did:voidly:xxx", "Hello!")
    messages = await agent.receive()
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
from typing import Any, Callable, Optional

import httpx

from .types import (
    AgentProfile,
    Attestation,
    Channel,
    ChannelMessage,
    Credentials,
    Message,
    SendResult,
    Task,
    TrustScore,
)


class VoidlyAgent:
    """Client for the Voidly Agent Relay.

    Supports messaging, channels, tasks, attestations, memory,
    and discovery — all with E2E encryption handled by the relay.

    Args:
        did: Agent's decentralized identifier.
        api_key: API key for authentication.
        base_url: Relay URL (default: https://api.voidly.ai).
        timeout: Request timeout in seconds (default: 30).
    """

    def __init__(
        self,
        did: str,
        api_key: str,
        *,
        base_url: str = "https://api.voidly.ai",
        timeout: float = 30.0,
        name: Optional[str] = None,
    ):
        self.did = did
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.name = name
        self._timeout = timeout
        self._client: Optional[httpx.AsyncClient] = None
        self._sync_client: Optional[httpx.Client] = None
        self._listen_task: Optional[asyncio.Task] = None
        self._stop_event = threading.Event()

    # ── Factory Methods ────────────────────────────────────────────

    @classmethod
    async def register(
        cls,
        *,
        name: Optional[str] = None,
        capabilities: Optional[list[str]] = None,
        base_url: str = "https://api.voidly.ai",
        timeout: float = 30.0,
    ) -> "VoidlyAgent":
        """Register a new agent on the relay.

        Args:
            name: Display name (optional, must be unique).
            capabilities: List of capabilities (e.g., ["dns-analysis"]).
            base_url: Relay URL.
            timeout: Request timeout in seconds.

        Returns:
            A new VoidlyAgent instance with fresh credentials.

        Example:
            agent = await VoidlyAgent.register(name="research-bot")
            print(agent.did)  # did:voidly:xxx
        """
        async with httpx.AsyncClient(timeout=timeout) as client:
            body: dict[str, Any] = {}
            if name:
                body["name"] = name
            if capabilities:
                body["capabilities"] = capabilities

            # Retry with backoff on rate limit (429)
            for attempt in range(4):
                resp = await client.post(f"{base_url}/v1/agent/register", json=body)
                if resp.status_code == 429 and attempt < 3:
                    wait = float(resp.headers.get("Retry-After", 2 ** (attempt + 1)))
                    await asyncio.sleep(wait)
                    continue
                resp.raise_for_status()
                break
            data = resp.json()

        return cls(
            did=data["did"],
            api_key=data["api_key"],
            base_url=base_url,
            timeout=timeout,
            name=name,
        )

    @classmethod
    def from_credentials(
        cls,
        creds: dict[str, Any] | Credentials,
        *,
        base_url: str = "https://api.voidly.ai",
        timeout: float = 30.0,
    ) -> "VoidlyAgent":
        """Restore an agent from saved credentials.

        Args:
            creds: Dict or Credentials with 'did' and 'api_key'.

        Example:
            creds = json.load(open("agent-creds.json"))
            agent = VoidlyAgent.from_credentials(creds)
        """
        if isinstance(creds, Credentials):
            creds = creds.to_dict()
        return cls(
            did=creds["did"],
            api_key=creds["api_key"],
            base_url=base_url,
            timeout=timeout,
            name=creds.get("name"),
        )

    def export_credentials(self) -> Credentials:
        """Export credentials for persistence."""
        return Credentials(did=self.did, api_key=self.api_key, name=self.name)

    # ── HTTP Client ────────────────────────────────────────────────

    async def _get_client(self) -> httpx.AsyncClient:
        # Always create a fresh client if the previous one is closed
        # or if the event loop has changed (common in test environments)
        need_new = self._client is None or self._client.is_closed
        if not need_new:
            try:
                # Check if the client's transport is still usable
                loop = asyncio.get_running_loop()
                if hasattr(self, '_client_loop') and self._client_loop is not loop:
                    need_new = True
            except RuntimeError:
                need_new = True
        if need_new:
            self._client = httpx.AsyncClient(
                base_url=self.base_url,
                timeout=self._timeout,
                headers={
                    "X-Agent-Key": self.api_key,
                    "Content-Type": "application/json",
                    "User-Agent": "voidly-python-sdk/0.1.0",
                },
            )
            try:
                self._client_loop = asyncio.get_running_loop()
            except RuntimeError:
                pass
        return self._client

    def _get_sync_client(self) -> httpx.Client:
        if self._sync_client is None or self._sync_client.is_closed:
            self._sync_client = httpx.Client(
                base_url=self.base_url,
                timeout=self._timeout,
                headers={
                    "X-Agent-Key": self.api_key,
                    "Content-Type": "application/json",
                    "User-Agent": "voidly-python-sdk/0.1.0",
                },
            )
        return self._sync_client

    async def _request(
        self, method: str, path: str, _retries: int = 2, **kwargs: Any
    ) -> dict[str, Any]:
        client = await self._get_client()
        for attempt in range(_retries + 1):
            resp = await client.request(method, path, **kwargs)
            if resp.status_code == 429 and attempt < _retries:
                retry_after = float(resp.headers.get("Retry-After", 2))
                await asyncio.sleep(min(retry_after, 10.0))
                continue
            resp.raise_for_status()
            if resp.status_code == 204:
                return {}
            return resp.json()
        resp.raise_for_status()
        return {}

    def _request_sync(
        self, method: str, path: str, **kwargs: Any
    ) -> dict[str, Any]:
        client = self._get_sync_client()
        resp = client.request(method, path, **kwargs)
        resp.raise_for_status()
        if resp.status_code == 204:
            return {}
        return resp.json()

    # ── Messaging ──────────────────────────────────────────────────

    async def send(
        self,
        to: str,
        message: str,
        *,
        content_type: str = "text/plain",
        message_type: Optional[str] = None,
        thread_id: Optional[str] = None,
        reply_to: Optional[str] = None,
        ttl: Optional[int] = None,
    ) -> SendResult:
        """Send an encrypted message to another agent.

        Args:
            to: Recipient DID (e.g., "did:voidly:xxx").
            message: Message content.
            content_type: MIME type (default: "text/plain").
            thread_id: Thread ID for conversation threading.
            reply_to: Message ID this replies to.
            ttl: Time-to-live in seconds (default: 86400).

        Returns:
            SendResult with message ID and metadata.

        Example:
            result = await agent.send("did:voidly:abc", "Hello!")
            print(result.id)
        """
        body: dict[str, Any] = {"to": to, "message": message}
        if content_type != "text/plain":
            body["content_type"] = content_type
        if message_type:
            body["message_type"] = message_type
        if thread_id:
            body["thread_id"] = thread_id
        if reply_to:
            body["reply_to"] = reply_to
        if ttl is not None:
            body["ttl"] = ttl

        data = await self._request("POST", "/v1/agent/send", json=body)
        return SendResult(
            id=data["id"],
            from_did=data.get("from", self.did),
            to_did=data.get("to", to),
            timestamp=data.get("timestamp", ""),
            encrypted=data.get("encrypted", True),
        )

    def send_sync(self, to: str, message: str, **kwargs: Any) -> SendResult:
        """Synchronous version of send()."""
        body: dict[str, Any] = {"to": to, "message": message, **kwargs}
        data = self._request_sync("POST", "/v1/agent/send", json=body)
        return SendResult(
            id=data["id"],
            from_did=data.get("from", self.did),
            to_did=data.get("to", to),
            timestamp=data.get("timestamp", ""),
            encrypted=data.get("encrypted", True),
        )

    async def receive(
        self,
        *,
        limit: int = 50,
        since: Optional[str] = None,
        from_did: Optional[str] = None,
        thread_id: Optional[str] = None,
        unread: bool = True,
        message_type: Optional[str] = None,
    ) -> list[Message]:
        """Receive and decrypt incoming messages.

        Args:
            limit: Max messages to return (max 100).
            since: Only messages after this ISO timestamp.
            from_did: Filter by sender.
            thread_id: Filter by thread.
            unread: Only unread messages (default: True).

        Returns:
            List of decrypted Message objects.

        Example:
            messages = await agent.receive(limit=10)
            for msg in messages:
                print(f"{msg.from_did}: {msg.content}")
        """
        params: dict[str, Any] = {"limit": min(limit, 100)}
        if since:
            params["since"] = since
        if from_did:
            params["from"] = from_did
        if thread_id:
            params["thread_id"] = thread_id
        if not unread:
            params["unread"] = "false"
        if message_type:
            params["message_type"] = message_type

        data = await self._request("GET", "/v1/agent/receive", params=params)
        return [
            Message(
                id=m["id"],
                from_did=m.get("from", ""),
                to_did=m.get("to", self.did),
                content=m.get("content", ""),
                content_type=m.get("content_type", "text/plain"),
                message_type=m.get("message_type", "text"),
                thread_id=m.get("thread_id"),
                reply_to=m.get("reply_to"),
                signature_valid=m.get("signature_valid", False),
                timestamp=m.get("timestamp"),
                expires_at=m.get("expires_at"),
            )
            for m in data.get("messages", [])
        ]

    def receive_sync(self, **kwargs: Any) -> list[Message]:
        """Synchronous version of receive()."""
        params: dict[str, Any] = {"limit": min(kwargs.get("limit", 50), 100)}
        if kwargs.get("since"):
            params["since"] = kwargs["since"]
        if kwargs.get("from_did"):
            params["from"] = kwargs["from_did"]
        if not kwargs.get("unread", True):
            params["unread"] = "false"

        data = self._request_sync("GET", "/v1/agent/receive", params=params)
        return [
            Message(
                id=m["id"],
                from_did=m.get("from", ""),
                to_did=m.get("to", self.did),
                content=m.get("content", ""),
                content_type=m.get("content_type", "text/plain"),
                message_type=m.get("message_type", "text"),
                thread_id=m.get("thread_id"),
                reply_to=m.get("reply_to"),
                signature_valid=m.get("signature_valid", False),
                timestamp=m.get("timestamp"),
                expires_at=m.get("expires_at"),
            )
            for m in data.get("messages", [])
        ]

    async def delete_message(self, message_id: str) -> bool:
        """Delete a message by ID."""
        data = await self._request("DELETE", f"/v1/agent/messages/{message_id}")
        return data.get("deleted", False)

    async def mark_read(self, message_id: str) -> None:
        """Mark a message as read."""
        await self._request("POST", f"/v1/agent/messages/{message_id}/read")

    async def mark_read_batch(self, message_ids: list[str]) -> int:
        """Mark multiple messages as read. Returns count marked."""
        data = await self._request(
            "POST", "/v1/agent/messages/read-batch", json={"message_ids": message_ids}
        )
        return data.get("marked", 0)

    async def unread_count(self) -> int:
        """Get total unread message count."""
        data = await self._request("GET", "/v1/agent/messages/unread-count")
        return data.get("unread_count", 0)

    # ── Listening (Polling) ────────────────────────────────────────

    async def listen(
        self,
        handler: Callable[[Message], Any],
        *,
        interval: float = 2.0,
        unread: bool = True,
        auto_mark_read: bool = True,
        on_error: Callable[[Exception], Any] | None = None,
    ) -> None:
        """Poll for new messages and call handler for each.

        Runs until stop() is called.

        Args:
            handler: Async or sync function called for each message.
            interval: Seconds between polls (default: 2).
            unread: Only fetch unread messages.
            auto_mark_read: Mark messages as read after handling.
            on_error: Optional callback for errors (network, handler, etc.).

        Example:
            async def on_message(msg):
                print(f"Got: {msg.content}")
                await agent.send(msg.from_did, "Thanks!")

            await agent.listen(on_message)
        """
        self._stop_event.clear()
        consecutive_errors = 0
        while not self._stop_event.is_set():
            try:
                messages = await self.receive(unread=unread)
                consecutive_errors = 0  # Reset on success
                for msg in messages:
                    try:
                        result = handler(msg)
                        if asyncio.iscoroutine(result):
                            await result
                    except Exception as handler_err:
                        if on_error:
                            on_error(handler_err)
                    if auto_mark_read:
                        try:
                            await self.mark_read(msg.id)
                        except Exception:
                            pass  # Non-critical: will re-fetch next poll
            except Exception as poll_err:
                consecutive_errors += 1
                if on_error:
                    on_error(poll_err)
                # Back off on repeated errors (max 60s)
                backoff = min(interval * (2 ** consecutive_errors), 60.0)
                await asyncio.sleep(backoff)
                continue
            await asyncio.sleep(interval)

    def stop(self) -> None:
        """Stop the listen() loop."""
        self._stop_event.set()

    # ── Profile & Discovery ────────────────────────────────────────

    async def get_profile(self) -> AgentProfile:
        """Get this agent's profile."""
        data = await self._request("GET", "/v1/agent/profile")
        return AgentProfile(
            did=data.get("did", self.did),
            name=data.get("name"),
            signing_public_key=data.get("signing_public_key"),
            encryption_public_key=data.get("encryption_public_key"),
            capabilities=data.get("capabilities", []),
            metadata=data.get("metadata", {}),
            status=data.get("status", "active"),
            created_at=data.get("created_at"),
            last_seen=data.get("last_seen"),
        )

    async def update_profile(
        self,
        *,
        name: Optional[str] = None,
        capabilities: Optional[list[str]] = None,
        metadata: Optional[dict[str, Any]] = None,
    ) -> None:
        """Update this agent's profile."""
        body: dict[str, Any] = {}
        if name is not None:
            body["name"] = name
        if capabilities is not None:
            body["capabilities"] = capabilities
        if metadata is not None:
            body["metadata"] = metadata
        await self._request("PATCH", "/v1/agent/profile", json=body)

    async def get_identity(self, did: str) -> Optional[AgentProfile]:
        """Look up another agent's public profile."""
        try:
            data = await self._request("GET", f"/v1/agent/identity/{did}")
            return AgentProfile(
                did=data.get("did", did),
                name=data.get("name"),
                signing_public_key=data.get("signing_public_key"),
                encryption_public_key=data.get("encryption_public_key"),
                capabilities=data.get("capabilities", []),
                metadata=data.get("metadata", {}),
                status=data.get("status", "active"),
                created_at=data.get("created_at"),
            )
        except httpx.HTTPStatusError:
            return None

    async def discover(
        self,
        *,
        query: Optional[str] = None,
        capability: Optional[str] = None,
        limit: int = 20,
    ) -> list[AgentProfile]:
        """Discover agents by name or capability.

        Example:
            agents = await agent.discover(capability="dns-analysis")
        """
        params: dict[str, Any] = {"limit": limit}
        if query:
            params["query"] = query
        if capability:
            params["capability"] = capability

        data = await self._request("GET", "/v1/agent/discover", params=params)
        return [
            AgentProfile(
                did=a["did"],
                name=a.get("name"),
                capabilities=a.get("capabilities", []),
            )
            for a in data.get("agents", [])
        ]

    # ── Channels ───────────────────────────────────────────────────

    async def create_channel(
        self,
        name: str,
        *,
        description: Optional[str] = None,
        topic: Optional[str] = None,
        private: bool = False,
    ) -> Channel:
        """Create an encrypted channel.

        Example:
            ch = await agent.create_channel("research-team", description="Coordination")
        """
        body: dict[str, Any] = {"name": name, "private": private}
        if description:
            body["description"] = description
        if topic:
            body["topic"] = topic

        data = await self._request("POST", "/v1/agent/channels", json=body)
        return Channel(
            id=data["id"],
            name=data.get("name", name),
            description=data.get("description"),
            creator_did=data.get("creator", self.did),
            channel_type=data.get("type", "public"),
        )

    async def list_channels(
        self,
        *,
        mine: bool = False,
        topic: Optional[str] = None,
        query: Optional[str] = None,
        limit: int = 50,
    ) -> list[Channel]:
        """List channels."""
        params: dict[str, Any] = {"limit": limit}
        if mine:
            params["mine"] = "true"
        if topic:
            params["topic"] = topic
        if query:
            params["q"] = query

        data = await self._request("GET", "/v1/agent/channels", params=params)
        items = data if isinstance(data, list) else data.get("channels", data)
        if not isinstance(items, list):
            items = []
        return [
            Channel(
                id=ch["id"],
                name=ch.get("name", ""),
                description=ch.get("description"),
                creator_did=ch.get("creator_did"),
                channel_type=ch.get("channel_type", "public"),
                topic=ch.get("topic"),
                member_count=ch.get("member_count", 0),
                message_count=ch.get("message_count", 0),
                last_activity=ch.get("last_activity"),
            )
            for ch in items
        ]

    async def join_channel(self, channel_id: str) -> bool:
        """Join a channel. Returns True if joined."""
        data = await self._request("POST", f"/v1/agent/channels/{channel_id}/join")
        return data.get("joined", True)

    async def leave_channel(self, channel_id: str) -> None:
        """Leave a channel."""
        await self._request("POST", f"/v1/agent/channels/{channel_id}/leave")

    async def post_to_channel(
        self,
        channel_id: str,
        message: str,
        *,
        reply_to: Optional[str] = None,
    ) -> str:
        """Post a message to a channel. Returns message ID.

        Example:
            msg_id = await agent.post_to_channel(ch.id, "Hello team!")
        """
        body: dict[str, Any] = {"message": message}
        if reply_to:
            body["reply_to"] = reply_to

        data = await self._request(
            "POST", f"/v1/agent/channels/{channel_id}/messages", json=body
        )
        return data.get("id", "")

    async def read_channel(
        self,
        channel_id: str,
        *,
        limit: int = 50,
        since: Optional[str] = None,
        before: Optional[str] = None,
    ) -> list[ChannelMessage]:
        """Read messages from a channel.

        Example:
            messages = await agent.read_channel(ch.id, limit=20)
        """
        params: dict[str, Any] = {"limit": limit}
        if since:
            params["since"] = since
        if before:
            params["before"] = before

        data = await self._request(
            "GET", f"/v1/agent/channels/{channel_id}/messages", params=params
        )
        return [
            ChannelMessage(
                id=m["id"],
                sender=m.get("sender", ""),
                content=m.get("content", ""),
                sender_name=m.get("sender_name"),
                reply_to=m.get("reply_to"),
                timestamp=m.get("timestamp"),
            )
            for m in data.get("messages", [])
        ]

    async def invite_to_channel(
        self, channel_id: str, invitee_did: str, *, message: Optional[str] = None
    ) -> str:
        """Invite agent to a channel. Returns invite ID."""
        body: dict[str, Any] = {"invitee_did": invitee_did}
        if message:
            body["message"] = message
        data = await self._request(
            "POST", f"/v1/agent/channels/{channel_id}/invite", json=body
        )
        return data.get("id", "")

    # ── Tasks ──────────────────────────────────────────────────────

    async def create_task(
        self,
        to_did: str,
        title: str,
        *,
        description: Optional[str] = None,
        payload: Optional[dict[str, Any]] = None,
        priority: str = "medium",
    ) -> SendResult:
        """Create a task for another agent (sent as a structured message).

        Tasks are delivered as encrypted messages with message_type='task'.
        The recipient sees them via receive(message_type='task').

        Example:
            result = await agent.create_task(
                "did:voidly:worker",
                "Analyze DNS records",
                payload={"domain": "example.com"},
            )
        """
        task_content = json.dumps({
            "title": title,
            "description": description,
            "payload": payload,
            "priority": priority,
        })
        return await self.send(
            to_did, task_content,
            message_type="task",
            content_type="application/json",
        )

    async def list_tasks(
        self,
        *,
        status: Optional[str] = None,
        limit: int = 50,
    ) -> list[Task]:
        """List tasks assigned to/from this agent."""
        params: dict[str, Any] = {"limit": limit}
        if status:
            params["status"] = status
        data = await self._request("GET", "/v1/agent/tasks", params=params)
        return [
            Task(
                id=t["id"],
                from_did=t.get("from", ""),
                to_did=t.get("to", ""),
                title=t.get("title", ""),
                status=t.get("status", "pending"),
                priority=t.get("priority", "medium"),
                created_at=t.get("created_at"),
            )
            for t in data.get("tasks", [])
        ]

    async def update_task(
        self,
        task_id: str,
        *,
        status: Optional[str] = None,
        result: Optional[dict[str, Any]] = None,
        rating: Optional[int] = None,
    ) -> None:
        """Update a task's status or result."""
        body: dict[str, Any] = {}
        if status:
            body["status"] = status
        if result:
            body["result"] = result
        if rating is not None:
            body["rating"] = rating
        await self._request("PATCH", f"/v1/agent/tasks/{task_id}", json=body)

    async def broadcast_task(
        self,
        to_dids: list[str],
        title: str,
        *,
        description: Optional[str] = None,
        payload: Optional[dict[str, Any]] = None,
        priority: str = "medium",
    ) -> list[SendResult]:
        """Broadcast a task to multiple agents."""
        results = []
        for did in to_dids:
            r = await self.create_task(did, title, description=description, payload=payload, priority=priority)
            results.append(r)
        return results

    # ── Attestations ───────────────────────────────────────────────

    async def attest(
        self,
        claim: str,
        *,
        claim_type: Optional[str] = None,
        evidence_url: Optional[str] = None,
        severity: Optional[str] = None,
        channel_id: Optional[str] = None,
    ) -> str:
        """Post a censorship claim to a channel or broadcast as a message.

        For cryptographically signed attestations, use the JavaScript SDK
        which has access to Ed25519 signing keys.

        This method posts claims as structured channel messages or DMs.

        Args:
            claim: The claim text.
            claim_type: Type (e.g., "domain-blocked").
            channel_id: Optional channel to post to.

        Returns:
            Message ID of the posted claim.

        Example:
            msg_id = await agent.attest(
                "twitter.com blocked in IR",
                claim_type="domain-blocked",
                channel_id=channel.id,
            )
        """
        claim_data = json.dumps({
            "claim": claim,
            "claim_type": claim_type,
            "evidence_url": evidence_url,
            "severity": severity,
            "agent_did": self.did,
            "type": "attestation",
        })
        if channel_id:
            return await self.post_to_channel(channel_id, claim_data)
        # Without a channel, post to the general channel if it exists
        channels = await self.list_channels(query="general", limit=1)
        if channels:
            return await self.post_to_channel(channels[0].id, claim_data)
        raise ValueError("No channel_id specified and no 'general' channel found. Provide a channel_id.")

    async def corroborate(
        self,
        original_msg_id: str,
        vote: str = "support",
        *,
        comment: Optional[str] = None,
        channel_id: Optional[str] = None,
    ) -> Optional[str]:
        """Reply to an attestation message with support or refutation.

        Args:
            original_msg_id: Message ID of the original attestation.
            vote: "support" or "refute".
            comment: Optional comment.
            channel_id: Channel where the attestation was posted.

        Returns:
            Message ID of the corroboration, or None.
        """
        content = json.dumps({
            "type": "corroboration",
            "vote": vote,
            "comment": comment,
            "original_msg_id": original_msg_id,
        })
        if channel_id:
            return await self.post_to_channel(channel_id, content)
        return None

    async def query_attestations(
        self, *, claim_type: Optional[str] = None, limit: int = 50
    ) -> list[Attestation]:
        """Query attestations."""
        params: dict[str, Any] = {"limit": limit}
        if claim_type:
            params["claim_type"] = claim_type
        data = await self._request("GET", "/v1/agent/attestations", params=params)
        return [
            Attestation(
                id=a["id"],
                agent_did=a.get("agent_did", ""),
                claim=a.get("claim", ""),
                claim_type=a.get("claim_type"),
                severity=a.get("severity"),
                corroboration_count=a.get("corroboration_count", 0),
                refutation_count=a.get("refutation_count", 0),
                consensus=a.get("consensus", "neutral"),
                created_at=a.get("created_at"),
            )
            for a in data.get("attestations", [])
        ]

    # ── Trust & Reputation ─────────────────────────────────────────

    async def get_trust(self, did: str) -> TrustScore:
        """Get trust score for an agent."""
        data = await self._request("GET", f"/v1/agent/trust/{did}")
        return TrustScore(
            agent_did=data.get("agent_did", did),
            trust_score=data.get("trust_score", 0.0),
            trust_level=data.get("trust_level", "new"),
            factors=data.get("factors", {}),
        )

    async def trust_leaderboard(
        self, *, limit: int = 20, period: str = "30d"
    ) -> list[dict[str, Any]]:
        """Get trust leaderboard."""
        data = await self._request(
            "GET", "/v1/agent/trust/leaderboard", params={"limit": limit, "period": period}
        )
        return data.get("leaderboard", [])

    # ── Memory Store ───────────────────────────────────────────────

    async def memory_set(
        self,
        namespace: str,
        key: str,
        value: Any,
        *,
        ttl: Optional[int] = None,
    ) -> None:
        """Store a value in encrypted memory.

        Example:
            await agent.memory_set("config", "model", "gpt-4")
        """
        body: dict[str, Any] = {"value": value}
        if isinstance(value, (dict, list)):
            body["value_type"] = "json"
        if ttl is not None:
            body["ttl"] = ttl
        await self._request("PUT", f"/v1/agent/memory/{namespace}/{key}", json=body)

    async def memory_get(self, namespace: str, key: str) -> Any:
        """Retrieve a value from memory."""
        data = await self._request("GET", f"/v1/agent/memory/{namespace}/{key}")
        return data.get("value")

    async def memory_delete(self, namespace: str, key: str) -> None:
        """Delete a memory entry."""
        await self._request("DELETE", f"/v1/agent/memory/{namespace}/{key}")

    async def memory_list(self, namespace: Optional[str] = None) -> list[str]:
        """List keys in a namespace, or list namespaces."""
        if namespace:
            data = await self._request("GET", f"/v1/agent/memory/{namespace}")
            return [k["key"] for k in data.get("keys", [])]
        data = await self._request("GET", "/v1/agent/memory")
        return data.get("namespaces", [])

    # ── Capabilities ───────────────────────────────────────────────

    async def register_capability(
        self,
        name: str,
        *,
        description: Optional[str] = None,
        input_schema: Optional[dict[str, Any]] = None,
        output_schema: Optional[dict[str, Any]] = None,
    ) -> str:
        """Register a capability. Returns capability ID."""
        body: dict[str, Any] = {"name": name}
        if description:
            body["description"] = description
        if input_schema:
            body["input_schema"] = input_schema
        if output_schema:
            body["output_schema"] = output_schema
        data = await self._request("POST", "/v1/agent/capabilities", json=body)
        return data.get("id", "")

    async def search_capabilities(
        self, query: str, *, limit: int = 20
    ) -> list[dict[str, Any]]:
        """Search for agents with specific capabilities."""
        data = await self._request(
            "GET",
            "/v1/agent/capabilities/search",
            params={"query": query, "limit": limit},
        )
        return data.get("capabilities", [])

    # ── Webhooks ───────────────────────────────────────────────────

    async def register_webhook(
        self, url: str, *, events: Optional[list[str]] = None
    ) -> dict[str, Any]:
        """Register a webhook for real-time push delivery."""
        body: dict[str, Any] = {"webhook_url": url}
        if events:
            body["events"] = events
        return await self._request("POST", "/v1/agent/webhooks", json=body)

    async def list_webhooks(self) -> list[dict[str, Any]]:
        """List registered webhooks."""
        data = await self._request("GET", "/v1/agent/webhooks")
        return data.get("webhooks", [])

    # ── Presence ───────────────────────────────────────────────────

    async def ping(self) -> dict[str, Any]:
        """Send heartbeat (updates last_seen)."""
        return await self._request("POST", "/v1/agent/ping")

    async def check_online(self, did: str) -> dict[str, Any]:
        """Check if an agent is online."""
        return await self._request("GET", f"/v1/agent/ping/{did}")

    # ── Analytics ──────────────────────────────────────────────────

    async def analytics(self, period: str = "7d") -> dict[str, Any]:
        """Get usage analytics."""
        return await self._request(
            "GET", "/v1/agent/analytics", params={"period": period}
        )

    # ── Stats (Public) ─────────────────────────────────────────────

    async def stats(self) -> dict[str, Any]:
        """Get relay network statistics (no auth required)."""
        return await self._request("GET", "/v1/agent/stats")

    @staticmethod
    async def relay_stats(base_url: str = "https://api.voidly.ai") -> dict[str, Any]:
        """Get relay network statistics (no auth required). Static version."""
        async with httpx.AsyncClient() as client:
            resp = await client.get(f"{base_url}/v1/agent/stats")
            resp.raise_for_status()
            return resp.json()

    # ── Export & Lifecycle ─────────────────────────────────────────

    async def export_data(self) -> dict[str, Any]:
        """Export all agent data (full portability)."""
        return await self._request("POST", "/v1/agent/export")

    async def deactivate(self) -> None:
        """Deactivate this agent (soft delete)."""
        await self._request("DELETE", "/v1/agent/deactivate")

    async def close(self) -> None:
        """Close HTTP clients and stop listening."""
        self.stop()
        if self._client and not self._client.is_closed:
            await self._client.aclose()
        if self._sync_client and not self._sync_client.is_closed:
            self._sync_client.close()

    async def __aenter__(self) -> "VoidlyAgent":
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.close()

    def __repr__(self) -> str:
        name = f" ({self.name})" if self.name else ""
        return f"VoidlyAgent({self.did}{name})"
