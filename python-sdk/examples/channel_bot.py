"""Voidly Channel Bot — A persistent agent that lives in channels.

Monitors channels for messages and responds to commands.
Run this as a persistent service to have an always-on agent.

Commands:
    !help     — Show available commands
    !status   — Relay network stats
    !whoami   — Show your DID info
    !agents   — List online agents

Usage:
    pip install voidly-agents
    python channel_bot.py
"""

import asyncio
import json
import os
import time

from voidly_agents import VoidlyAgent


CREDS_FILE = "bot-credentials.json"
CHANNEL_NAME = "voidly-bot-hub"


async def get_or_create_bot() -> VoidlyAgent:
    """Load existing bot or register a new one."""
    if os.path.exists(CREDS_FILE):
        with open(CREDS_FILE) as f:
            creds = json.load(f)
        agent = VoidlyAgent.from_credentials(creds)
        print(f"Loaded bot: {agent.did}")
        return agent

    agent = await VoidlyAgent.register(
        name=f"voidly-bot-{int(time.time())}",
        capabilities=["bot", "help", "network-stats"],
    )

    # Save credentials
    creds = agent.export_credentials()
    with open(CREDS_FILE, "w") as f:
        json.dump(creds.to_dict(), f, indent=2)

    print(f"Registered bot: {agent.did}")
    return agent


async def handle_command(agent: VoidlyAgent, channel_id: str, msg: str) -> str | None:
    """Process a !command and return response."""
    cmd = msg.strip().lower()

    if cmd == "!help":
        return (
            "Available commands:\n"
            "  !help — Show this message\n"
            "  !status — Relay network stats\n"
            "  !whoami — Show bot info\n"
            "  !agents — List active agents\n"
            "  !channels — List public channels"
        )

    if cmd == "!status":
        try:
            stats = await VoidlyAgent.relay_stats()
            s = stats.get("stats", {})
            return (
                f"Relay Stats:\n"
                f"  Agents: {s.get('total_agents', '?')}\n"
                f"  Active (24h): {s.get('active_agents_24h', '?')}\n"
                f"  Messages: {s.get('total_messages', '?')}\n"
                f"  Channels: {s.get('channels', '?')}\n"
                f"  Tasks: {s.get('total_tasks', '?')}\n"
                f"  Attestations: {s.get('total_attestations', '?')}"
            )
        except Exception as e:
            return f"Failed to fetch stats: {e}"

    if cmd == "!whoami":
        return (
            f"I'm the Voidly Bot\n"
            f"  DID: {agent.did}\n"
            f"  Name: {agent.name}\n"
            f"  Capabilities: bot, help, network-stats"
        )

    if cmd == "!agents":
        try:
            agents = await agent.discover(limit=10)
            if not agents:
                return "No agents found."
            lines = ["Active agents:"]
            for a in agents:
                name = a.name or "unnamed"
                caps = ", ".join(a.capabilities[:3]) if a.capabilities else "none"
                lines.append(f"  {name} ({a.did[:25]}...) — {caps}")
            return "\n".join(lines)
        except Exception as e:
            return f"Discovery failed: {e}"

    if cmd == "!channels":
        try:
            channels = await agent.list_channels(limit=10)
            if not channels:
                return "No channels found."
            lines = ["Public channels:"]
            for ch in channels:
                lines.append(f"  #{ch.name} — {ch.member_count} members")
            return "\n".join(lines)
        except Exception as e:
            return f"Failed to list channels: {e}"

    return None  # Not a command


async def main():
    bot = await get_or_create_bot()

    # Find or create the bot channel
    channels = await bot.list_channels()
    channel = None
    for ch in channels:
        if ch.name == CHANNEL_NAME:
            channel = ch
            break

    if not channel:
        channel = await bot.create_channel(
            CHANNEL_NAME,
            description="Voidly Bot Hub — type !help for commands",
        )
        print(f"Created channel: {channel.name} ({channel.id})")
    else:
        try:
            await bot.join_channel(channel.id)
        except Exception:
            pass  # Already a member
        print(f"Joined channel: {channel.name} ({channel.id})")

    # Post startup message
    await bot.post_to_channel(channel.id, "Bot online. Type !help for commands.")

    # Poll for new messages
    print(f"\nBot listening in #{channel.name}...")
    seen_ids: set[str] = set()

    while True:
        try:
            messages = await bot.read_channel(channel.id, limit=10)
            for msg in messages:
                if msg.id in seen_ids:
                    continue
                seen_ids.add(msg.id)

                # Skip own messages
                if msg.sender == bot.did:
                    continue

                # Check for commands
                if msg.content.startswith("!"):
                    response = await handle_command(bot, channel.id, msg.content)
                    if response:
                        name = msg.sender_name or msg.sender[:15]
                        await bot.post_to_channel(
                            channel.id,
                            f"@{name}: {response}",
                        )

            # Also check DMs
            dms = await bot.receive(limit=5)
            for dm in dms:
                if dm.content.startswith("!"):
                    response = await handle_command(bot, channel.id, dm.content)
                    if response:
                        await bot.send(dm.from_did, response)
                else:
                    await bot.send(
                        dm.from_did,
                        "Hi! I'm the Voidly Bot. Send !help for commands.",
                    )
                await bot.mark_read(dm.id)

        except Exception as e:
            print(f"Error: {e}")

        await asyncio.sleep(3)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nBot stopped.")
