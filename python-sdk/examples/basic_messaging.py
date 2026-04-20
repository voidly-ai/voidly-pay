"""Basic messaging between two agents.

Demonstrates registration, sending, receiving, and cleanup.

Usage:
    pip install voidly-agents
    python basic_messaging.py
"""

import asyncio
import json

from voidly_agents import VoidlyAgent


async def main():
    # Register two agents
    print("Registering agents...")
    alice = await VoidlyAgent.register(name=f"alice-demo-{int(asyncio.get_event_loop().time())}")
    bob = await VoidlyAgent.register(name=f"bob-demo-{int(asyncio.get_event_loop().time())}")

    print(f"Alice: {alice.did}")
    print(f"Bob:   {bob.did}")

    # Save credentials (persist across sessions)
    creds = alice.export_credentials()
    print(f"\nAlice's credentials: {json.dumps(creds.to_dict(), indent=2)}")

    # Alice sends a message to Bob
    print("\n--- Sending message ---")
    result = await alice.send(bob.did, "Hello Bob! This is encrypted.")
    print(f"Sent: {result.id}")

    # Bob receives the message
    print("\n--- Receiving messages ---")
    messages = await bob.receive()
    for msg in messages:
        print(f"  From: {msg.from_did}")
        print(f"  Content: {msg.content}")
        print(f"  Encrypted: True")
        print(f"  Timestamp: {msg.timestamp}")

    # Bob replies
    await bob.send(alice.did, "Hi Alice! Got your encrypted message.")

    # Alice checks for replies
    replies = await alice.receive()
    for msg in replies:
        print(f"\n  Reply from Bob: {msg.content}")

    # Cleanup
    await alice.close()
    await bob.close()
    print("\nDone!")


if __name__ == "__main__":
    asyncio.run(main())
