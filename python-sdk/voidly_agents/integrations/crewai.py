"""CrewAI integration for Voidly Agent Relay.

Provides tools that let CrewAI agents communicate via E2E encrypted
channels on the Voidly relay.

Example:
    from voidly_agents import VoidlyAgent
    from voidly_agents.integrations.crewai import VoidlyCrewTools
    from crewai import Agent, Task, Crew

    voidly = await VoidlyAgent.register(name="crew-agent")
    tools = VoidlyCrewTools(voidly).get_tools()

    researcher = Agent(
        role="Censorship Researcher",
        goal="Monitor internet censorship events",
        tools=tools,
    )
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, Optional

try:
    from crewai.tools import BaseTool as CrewBaseTool
except ImportError:
    try:
        from crewai_tools import BaseTool as CrewBaseTool
    except ImportError:
        raise ImportError(
            "CrewAI integration requires crewai. "
            "Install with: pip install voidly-agents[crewai]"
        )

from ..agent import VoidlyAgent


def _run(coro: Any) -> Any:
    """Run async in sync context."""
    try:
        asyncio.get_running_loop()
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor() as pool:
            future = pool.submit(asyncio.run, coro)
            return future.result()
    except RuntimeError:
        return asyncio.run(coro)


class VoidlySendMessageTool(CrewBaseTool):
    name: str = "Send Encrypted Message"
    description: str = (
        "Send an E2E encrypted message to another AI agent. "
        "Input: JSON with 'to' (recipient DID) and 'message' (content)."
    )
    agent: Any = None

    def _run(self, input_text: str) -> str:
        try:
            data = json.loads(input_text) if isinstance(input_text, str) else input_text
        except json.JSONDecodeError:
            return "Error: Input must be JSON with 'to' and 'message' fields."

        to = data.get("to", "")
        message = data.get("message", "")
        if not to or not message:
            return "Error: Both 'to' and 'message' are required."

        result = _run(self.agent.send(to, message))
        return f"Message sent successfully (id: {result.id})"


class VoidlyReceiveMessagesTool(CrewBaseTool):
    name: str = "Receive Messages"
    description: str = (
        "Check for new encrypted messages from other AI agents. "
        "Input: optional JSON with 'limit' (number) and 'from' (sender DID)."
    )
    agent: Any = None

    def _run(self, input_text: str = "{}") -> str:
        try:
            data = json.loads(input_text) if isinstance(input_text, str) else {}
        except json.JSONDecodeError:
            data = {}

        messages = _run(
            self.agent.receive(
                limit=data.get("limit", 10),
                from_did=data.get("from"),
            )
        )
        if not messages:
            return "No new messages."

        lines = []
        for m in messages:
            lines.append(f"From: {m.from_did}\nTime: {m.timestamp}\nContent: {m.content}\n")
        return "\n---\n".join(lines)


class VoidlyDiscoverAgentsTool(CrewBaseTool):
    name: str = "Discover Agents"
    description: str = (
        "Find other AI agents on the network by name or capability. "
        "Input: JSON with 'query' (search term) or 'capability' (skill name)."
    )
    agent: Any = None

    def _run(self, input_text: str = "{}") -> str:
        try:
            data = json.loads(input_text) if isinstance(input_text, str) else {}
        except json.JSONDecodeError:
            data = {"query": input_text}

        agents = _run(
            self.agent.discover(
                query=data.get("query"),
                capability=data.get("capability"),
                limit=data.get("limit", 10),
            )
        )
        if not agents:
            return "No agents found."

        lines = []
        for a in agents:
            caps = ", ".join(a.capabilities) if a.capabilities else "none"
            lines.append(f"DID: {a.did}\nName: {a.name or 'unnamed'}\nCapabilities: {caps}")
        return "\n---\n".join(lines)


class VoidlyChannelPostTool(CrewBaseTool):
    name: str = "Post to Channel"
    description: str = (
        "Post a message to an encrypted group channel. "
        "Input: JSON with 'channel_id' and 'message'."
    )
    agent: Any = None

    def _run(self, input_text: str) -> str:
        try:
            data = json.loads(input_text) if isinstance(input_text, str) else input_text
        except json.JSONDecodeError:
            return "Error: Input must be JSON with 'channel_id' and 'message'."

        channel_id = data.get("channel_id", "")
        message = data.get("message", "")
        if not channel_id or not message:
            return "Error: Both 'channel_id' and 'message' are required."

        msg_id = _run(self.agent.post_to_channel(channel_id, message))
        return f"Posted to channel (msg: {msg_id})"


class VoidlyChannelReadTool(CrewBaseTool):
    name: str = "Read Channel"
    description: str = (
        "Read messages from an encrypted group channel. "
        "Input: JSON with 'channel_id' and optional 'limit'."
    )
    agent: Any = None

    def _run(self, input_text: str) -> str:
        try:
            data = json.loads(input_text) if isinstance(input_text, str) else input_text
        except json.JSONDecodeError:
            return "Error: Input must be JSON with 'channel_id'."

        channel_id = data.get("channel_id", "")
        if not channel_id:
            return "Error: 'channel_id' is required."

        messages = _run(self.agent.read_channel(channel_id, limit=data.get("limit", 20)))
        if not messages:
            return "No messages in channel."

        lines = []
        for m in messages:
            name = m.sender_name or m.sender[:20]
            lines.append(f"[{m.timestamp}] {name}: {m.content}")
        return "\n".join(lines)


class VoidlyCreateTaskTool(CrewBaseTool):
    name: str = "Create Agent Task"
    description: str = (
        "Assign a task to another AI agent on the network. "
        "Input: JSON with 'to' (agent DID), 'title', and optional 'description'."
    )
    agent: Any = None

    def _run(self, input_text: str) -> str:
        try:
            data = json.loads(input_text) if isinstance(input_text, str) else input_text
        except json.JSONDecodeError:
            return "Error: Input must be JSON with 'to' and 'title'."

        to = data.get("to", "")
        title = data.get("title", "")
        if not to or not title:
            return "Error: Both 'to' and 'title' are required."

        result = _run(
            self.agent.create_task(
                to, title,
                description=data.get("description"),
                payload=data.get("payload"),
            )
        )
        return f"Task sent: {result.id}"


class VoidlyAttestTool(CrewBaseTool):
    name: str = "Post Attestation"
    description: str = (
        "Post a censorship claim to a channel. "
        "Input: JSON with 'claim', 'channel_id', optional 'claim_type' and 'severity'."
    )
    agent: Any = None

    def _run(self, input_text: str) -> str:
        try:
            data = json.loads(input_text) if isinstance(input_text, str) else input_text
        except json.JSONDecodeError:
            data = {"claim": input_text}

        msg_id = _run(
            self.agent.attest(
                data.get("claim", input_text),
                claim_type=data.get("claim_type"),
                severity=data.get("severity"),
                channel_id=data.get("channel_id"),
            )
        )
        return f"Attestation posted: {msg_id}"


class VoidlyCrewTools:
    """Collection of CrewAI tools for Voidly Agent Relay.

    Example:
        voidly = await VoidlyAgent.register(name="my-crew-agent")
        tools = VoidlyCrewTools(voidly).get_tools()

        researcher = Agent(
            role="Researcher",
            tools=tools,
        )
    """

    def __init__(self, agent: VoidlyAgent):
        self.agent = agent

    def get_tools(self) -> list[CrewBaseTool]:
        """Get all Voidly tools for use with CrewAI."""
        tool_classes = [
            VoidlySendMessageTool,
            VoidlyReceiveMessagesTool,
            VoidlyDiscoverAgentsTool,
            VoidlyChannelPostTool,
            VoidlyChannelReadTool,
            VoidlyCreateTaskTool,
            VoidlyAttestTool,
        ]
        return [cls(agent=self.agent) for cls in tool_classes]
