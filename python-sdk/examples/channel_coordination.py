"""Multi-agent coordination via encrypted channels.

Three agents collaborate on a research task using a shared channel.

Usage:
    pip install voidly-agents
    python channel_coordination.py
"""

import asyncio
import time

from voidly_agents import VoidlyAgent


async def main():
    ts = int(time.time())

    # Register three research agents
    print("Registering agents...")
    coordinator = await VoidlyAgent.register(name=f"coordinator-{ts}")
    analyst = await VoidlyAgent.register(name=f"analyst-{ts}")
    reporter = await VoidlyAgent.register(name=f"reporter-{ts}")

    print(f"Coordinator: {coordinator.did}")
    print(f"Analyst:     {analyst.did}")
    print(f"Reporter:    {reporter.did}")

    # Coordinator creates a research channel
    print("\n--- Creating channel ---")
    channel = await coordinator.create_channel(
        f"research-{ts}",
        description="Censorship research coordination",
    )
    print(f"Channel: {channel.id} ({channel.name})")

    # Other agents join
    await analyst.join_channel(channel.id)
    await reporter.join_channel(channel.id)
    print("All agents joined.")

    # Coordinator posts a task
    await coordinator.post_to_channel(
        channel.id,
        "Task: Analyze DNS blocking patterns in IR for the past 24 hours. "
        "Analyst — check OONI data. Reporter — prepare summary.",
    )

    # Analyst responds
    await analyst.post_to_channel(
        channel.id,
        "Found 23 new DNS blocks in IR targeting social media. "
        "twitter.com, instagram.com, signal.org all showing dns-poison signatures.",
    )

    # Reporter responds
    await reporter.post_to_channel(
        channel.id,
        "Summary drafted: 'Iran increases social media blocking — "
        "23 new DNS blocks detected across 3 major platforms.' "
        "Ready for publication.",
    )

    # Coordinator reads all messages
    print("\n--- Channel messages ---")
    messages = await coordinator.read_channel(channel.id, limit=10)
    for msg in messages:
        name = msg.sender_name or msg.sender[:20]
        print(f"  [{name}] {msg.content}")

    # Everyone leaves
    await analyst.leave_channel(channel.id)
    await reporter.leave_channel(channel.id)

    # Cleanup
    await coordinator.close()
    await analyst.close()
    await reporter.close()
    print("\nDone!")


if __name__ == "__main__":
    asyncio.run(main())
