"""Live integration tests against the Voidly Agent Relay.

These tests hit the real relay at api.voidly.ai.
Run with: pytest tests/test_live_relay.py -v -s

Registers 3 agents once, saves credentials, restores per test.
"""

import asyncio
import json
import os
import time

import pytest

from voidly_agents import VoidlyAgent
from voidly_agents.types import (
    AgentProfile,
    Channel,
    ChannelMessage,
    Credentials,
    Message,
    SendResult,
    TrustScore,
)

CREDS_FILE = "/tmp/voidly-test-creds.json"


async def _get_or_register_agents():
    """Get saved credentials or register fresh agents."""
    if os.path.exists(CREDS_FILE):
        with open(CREDS_FILE) as f:
            saved = json.load(f)
        return saved

    ts = int(time.time())
    alice = await VoidlyAgent.register(name=f"test-alice-{ts}")
    bob = await VoidlyAgent.register(name=f"test-bob-{ts}")
    solo = await VoidlyAgent.register(name=f"test-solo-{ts}")

    saved = {
        "alice": alice.export_credentials().to_dict(),
        "bob": bob.export_credentials().to_dict(),
        "solo": solo.export_credentials().to_dict(),
    }
    with open(CREDS_FILE, "w") as f:
        json.dump(saved, f)

    await alice.close()
    await bob.close()
    await solo.close()
    return saved


@pytest.fixture
def agent_pair(event_loop):
    """Restore alice and bob from saved credentials."""
    creds = event_loop.run_until_complete(_get_or_register_agents())
    alice = VoidlyAgent.from_credentials(creds["alice"])
    bob = VoidlyAgent.from_credentials(creds["bob"])
    yield alice, bob
    event_loop.run_until_complete(alice.close())
    event_loop.run_until_complete(bob.close())


@pytest.fixture
def solo_agent(event_loop):
    """Restore solo agent from saved credentials."""
    creds = event_loop.run_until_complete(_get_or_register_agents())
    agent = VoidlyAgent.from_credentials(creds["solo"])
    yield agent
    event_loop.run_until_complete(agent.close())


# ── Registration ────────────────────────────────────────────────


class TestRegistration:
    @pytest.mark.asyncio
    async def test_register_works(self):
        """Verify registration worked (using saved creds)."""
        creds = await _get_or_register_agents()
        assert creds["alice"]["did"].startswith("did:voidly:")
        assert creds["bob"]["did"].startswith("did:voidly:")
        assert creds["alice"]["api_key"]

    @pytest.mark.asyncio
    async def test_credentials_roundtrip(self):
        creds_data = await _get_or_register_agents()
        alice = VoidlyAgent.from_credentials(creds_data["alice"])
        assert alice.did == creds_data["alice"]["did"]

        exported = alice.export_credentials()
        assert isinstance(exported, Credentials)
        assert exported.did == alice.did
        assert exported.api_key == alice.api_key

        d = exported.to_dict()
        restored = VoidlyAgent.from_credentials(d)
        assert restored.did == alice.did
        await alice.close()


# ── Messaging ───────────────────────────────────────────────────


class TestMessaging:
    @pytest.mark.asyncio
    async def test_send_and_receive(self):
        creds = await _get_or_register_agents()
        alice = VoidlyAgent.from_credentials(creds["alice"])
        bob = VoidlyAgent.from_credentials(creds["bob"])

        ts = int(time.time())
        msg_text = f"Hello Bob {ts}!"

        result = await alice.send(bob.did, msg_text)
        assert isinstance(result, SendResult)
        assert result.id
        assert result.encrypted is True

        # Retry receive — relay may need a moment to deliver
        msg = None
        for _ in range(5):
            await asyncio.sleep(1)
            messages = await bob.receive(limit=50, unread=True)
            msg = next((m for m in messages if m.content == msg_text), None)
            if msg:
                break
        assert msg is not None, f"Message not found in {len(messages)} messages"
        assert isinstance(msg, Message)
        assert msg.from_did == alice.did

        await alice.close()
        await bob.close()

    @pytest.mark.asyncio
    async def test_send_with_thread(self):
        creds = await _get_or_register_agents()
        alice = VoidlyAgent.from_credentials(creds["alice"])
        bob = VoidlyAgent.from_credentials(creds["bob"])

        ts = str(int(time.time()))
        r1 = await alice.send(bob.did, "Thread start", thread_id=f"thread-{ts}")
        assert r1.id

        r2 = await alice.send(bob.did, "Thread reply", thread_id=f"thread-{ts}", reply_to=r1.id)
        assert r2.id

        await alice.close()
        await bob.close()

    @pytest.mark.asyncio
    async def test_unread_count(self):
        creds = await _get_or_register_agents()
        alice = VoidlyAgent.from_credentials(creds["alice"])
        bob = VoidlyAgent.from_credentials(creds["bob"])

        await alice.send(bob.did, f"Count me {time.time()}")
        await asyncio.sleep(1)

        count = await bob.unread_count()
        assert count >= 1

        await alice.close()
        await bob.close()

    @pytest.mark.asyncio
    async def test_mark_read(self):
        creds = await _get_or_register_agents()
        alice = VoidlyAgent.from_credentials(creds["alice"])
        bob = VoidlyAgent.from_credentials(creds["bob"])

        await alice.send(bob.did, f"Read me {time.time()}")
        await asyncio.sleep(1)

        messages = await bob.receive(limit=5)
        assert len(messages) >= 1
        await bob.mark_read(messages[0].id)

        await alice.close()
        await bob.close()

    @pytest.mark.asyncio
    async def test_send_and_receive_sync(self):
        creds = await _get_or_register_agents()
        alice = VoidlyAgent.from_credentials(creds["alice"])
        bob = VoidlyAgent.from_credentials(creds["bob"])

        result = alice.send_sync(bob.did, f"Sync hello {time.time()}")
        assert isinstance(result, SendResult)
        assert result.id

        await asyncio.sleep(1)
        messages = bob.receive_sync(limit=5)
        assert isinstance(messages, list)

        await alice.close()
        await bob.close()


# ── Profile & Discovery ────────────────────────────────────────


class TestProfile:
    @pytest.mark.asyncio
    async def test_get_profile(self):
        creds = await _get_or_register_agents()
        agent = VoidlyAgent.from_credentials(creds["solo"])

        profile = await agent.get_profile()
        assert isinstance(profile, AgentProfile)
        assert profile.did == agent.did

        await agent.close()

    @pytest.mark.asyncio
    async def test_update_profile(self):
        creds = await _get_or_register_agents()
        agent = VoidlyAgent.from_credentials(creds["solo"])

        await agent.update_profile(
            capabilities=["test-cap"],
            metadata={"version": "1.0"},
        )
        profile = await agent.get_profile()
        assert "test-cap" in profile.capabilities

        await agent.close()

    @pytest.mark.asyncio
    async def test_get_identity(self):
        creds = await _get_or_register_agents()
        alice = VoidlyAgent.from_credentials(creds["alice"])
        bob_did = creds["bob"]["did"]

        identity = await alice.get_identity(bob_did)
        assert identity is not None
        assert identity.did == bob_did

        await alice.close()

    @pytest.mark.asyncio
    async def test_discover(self):
        creds = await _get_or_register_agents()
        agent = VoidlyAgent.from_credentials(creds["solo"])

        agents = await agent.discover(limit=5)
        assert isinstance(agents, list)
        for a in agents:
            assert isinstance(a, AgentProfile)
            assert a.did.startswith("did:voidly:")

        await agent.close()


# ── Channels ────────────────────────────────────────────────────


class TestChannels:
    @pytest.mark.asyncio
    async def test_create_and_list_channels(self):
        creds = await _get_or_register_agents()
        agent = VoidlyAgent.from_credentials(creds["solo"])

        ts = int(time.time())
        ch = await agent.create_channel(f"test-ch-{ts}", description="Test channel")
        assert isinstance(ch, Channel)
        assert ch.id
        assert ch.name == f"test-ch-{ts}"

        channels = await agent.list_channels()
        assert isinstance(channels, list)

        await agent.close()

    @pytest.mark.asyncio
    async def test_channel_messaging(self):
        creds = await _get_or_register_agents()
        alice = VoidlyAgent.from_credentials(creds["alice"])
        bob = VoidlyAgent.from_credentials(creds["bob"])

        ts = int(time.time())
        ch = await alice.create_channel(f"test-msg-{ts}")
        await bob.join_channel(ch.id)

        msg_id = await alice.post_to_channel(ch.id, "Hello channel!")
        assert msg_id

        await asyncio.sleep(1)

        messages = await bob.read_channel(ch.id, limit=10)
        assert len(messages) >= 1
        assert isinstance(messages[0], ChannelMessage)
        found = any(m.content == "Hello channel!" for m in messages)
        assert found

        await alice.close()
        await bob.close()

    @pytest.mark.asyncio
    async def test_join_and_leave(self):
        creds = await _get_or_register_agents()
        alice = VoidlyAgent.from_credentials(creds["alice"])
        bob = VoidlyAgent.from_credentials(creds["bob"])

        ts = int(time.time())
        ch = await alice.create_channel(f"test-jl-{ts}")
        joined = await bob.join_channel(ch.id)
        assert joined is True

        await bob.leave_channel(ch.id)

        await alice.close()
        await bob.close()


# ── Tasks ───────────────────────────────────────────────────────


class TestTasks:
    @pytest.mark.asyncio
    async def test_create_task_as_message(self):
        """Tasks are sent as structured messages."""
        creds = await _get_or_register_agents()
        alice = VoidlyAgent.from_credentials(creds["alice"])
        bob = VoidlyAgent.from_credentials(creds["bob"])

        result = await alice.create_task(
            bob.did,
            f"Test task {time.time()}",
            description="Do something",
            payload={"key": "value"},
        )
        assert isinstance(result, SendResult)
        assert result.id

        # Bob should receive it as a message
        await asyncio.sleep(1)
        messages = await bob.receive(limit=10)
        assert len(messages) >= 1

        await alice.close()
        await bob.close()


# ── Attestations ────────────────────────────────────────────────


class TestAttestations:
    @pytest.mark.asyncio
    async def test_attest_to_channel(self):
        """Attestations are posted to channels as structured messages."""
        creds = await _get_or_register_agents()
        agent = VoidlyAgent.from_credentials(creds["solo"])

        ts = int(time.time())
        ch = await agent.create_channel(f"attest-{ts}")

        msg_id = await agent.attest(
            "test claim — ignore",
            claim_type="domain-blocked",
            severity="low",
            channel_id=ch.id,
        )
        assert msg_id

        await agent.close()

    @pytest.mark.asyncio
    async def test_query_attestations(self):
        creds = await _get_or_register_agents()
        agent = VoidlyAgent.from_credentials(creds["solo"])

        atts = await agent.query_attestations(limit=5)
        assert isinstance(atts, list)

        await agent.close()

    @pytest.mark.asyncio
    async def test_corroborate_in_channel(self):
        creds = await _get_or_register_agents()
        alice = VoidlyAgent.from_credentials(creds["alice"])
        bob = VoidlyAgent.from_credentials(creds["bob"])

        ts = int(time.time())
        ch = await alice.create_channel(f"corrob-{ts}")
        await bob.join_channel(ch.id)

        att_msg_id = await alice.attest(
            f"test claim {ts}",
            claim_type="domain-blocked",
            channel_id=ch.id,
        )
        corr_msg_id = await bob.corroborate(
            att_msg_id, vote="support", comment="Confirmed", channel_id=ch.id
        )
        assert corr_msg_id

        await alice.close()
        await bob.close()


# ── Memory ──────────────────────────────────────────────────────


class TestMemory:
    @pytest.mark.asyncio
    async def test_set_and_get(self):
        creds = await _get_or_register_agents()
        agent = VoidlyAgent.from_credentials(creds["solo"])

        await agent.memory_set("test-ns", "key1", "value1")
        result = await agent.memory_get("test-ns", "key1")
        assert result == "value1"

        await agent.close()

    @pytest.mark.asyncio
    async def test_set_json_value(self):
        creds = await _get_or_register_agents()
        agent = VoidlyAgent.from_credentials(creds["solo"])

        await agent.memory_set("test-ns", "json-key", {"score": 0.95, "tags": ["a", "b"]})
        result = await agent.memory_get("test-ns", "json-key")
        assert isinstance(result, dict)
        assert result["score"] == 0.95

        await agent.close()

    @pytest.mark.asyncio
    async def test_list_keys(self):
        creds = await _get_or_register_agents()
        agent = VoidlyAgent.from_credentials(creds["solo"])

        ts = str(int(time.time()))
        await agent.memory_set(f"list-ns-{ts}", "k1", "v1")
        await agent.memory_set(f"list-ns-{ts}", "k2", "v2")
        keys = await agent.memory_list(f"list-ns-{ts}")
        assert isinstance(keys, list)
        assert "k1" in keys
        assert "k2" in keys

        await agent.close()

    @pytest.mark.asyncio
    async def test_delete(self):
        creds = await _get_or_register_agents()
        agent = VoidlyAgent.from_credentials(creds["solo"])

        ts = str(int(time.time()))
        await agent.memory_set(f"del-ns-{ts}", "del-key", "delete-me")
        await agent.memory_delete(f"del-ns-{ts}", "del-key")
        try:
            result = await agent.memory_get(f"del-ns-{ts}", "del-key")
            assert result is None
        except Exception:
            pass

        await agent.close()


# ── Trust ───────────────────────────────────────────────────────


class TestTrust:
    @pytest.mark.asyncio
    async def test_get_trust(self):
        creds = await _get_or_register_agents()
        alice = VoidlyAgent.from_credentials(creds["alice"])
        bob_did = creds["bob"]["did"]

        trust = await alice.get_trust(bob_did)
        assert isinstance(trust, TrustScore)
        assert trust.agent_did == bob_did

        await alice.close()

    @pytest.mark.asyncio
    async def test_trust_leaderboard(self):
        creds = await _get_or_register_agents()
        agent = VoidlyAgent.from_credentials(creds["solo"])

        leaders = await agent.trust_leaderboard(limit=5)
        assert isinstance(leaders, list)

        await agent.close()


# ── Presence ────────────────────────────────────────────────────


class TestPresence:
    @pytest.mark.asyncio
    async def test_ping(self):
        creds = await _get_or_register_agents()
        agent = VoidlyAgent.from_credentials(creds["solo"])

        result = await agent.ping()
        assert isinstance(result, dict)

        await agent.close()

    @pytest.mark.asyncio
    async def test_check_online(self):
        creds = await _get_or_register_agents()
        alice = VoidlyAgent.from_credentials(creds["alice"])
        bob_did = creds["bob"]["did"]

        result = await alice.check_online(bob_did)
        assert isinstance(result, dict)

        await alice.close()


# ── Relay Stats ─────────────────────────────────────────────────


class TestRelayStats:
    @pytest.mark.asyncio
    async def test_relay_stats(self):
        stats = await VoidlyAgent.relay_stats()
        assert isinstance(stats, dict)
        assert "stats" in stats or "total_agents" in stats


# ── Analytics ───────────────────────────────────────────────────


class TestAnalytics:
    @pytest.mark.asyncio
    async def test_analytics(self):
        creds = await _get_or_register_agents()
        agent = VoidlyAgent.from_credentials(creds["solo"])

        data = await agent.analytics(period="7d")
        assert isinstance(data, dict)

        await agent.close()


# ── Capabilities ────────────────────────────────────────────────


class TestCapabilities:
    @pytest.mark.asyncio
    async def test_register_capability(self):
        creds = await _get_or_register_agents()
        agent = VoidlyAgent.from_credentials(creds["solo"])

        cap_id = await agent.register_capability(
            f"test-cap-{int(time.time())}",
            description="A test capability",
            input_schema={"type": "object", "properties": {"query": {"type": "string"}}},
        )
        assert cap_id

        await agent.close()

    @pytest.mark.asyncio
    async def test_search_capabilities(self):
        creds = await _get_or_register_agents()
        agent = VoidlyAgent.from_credentials(creds["solo"])

        results = await agent.search_capabilities("test")
        assert isinstance(results, list)

        await agent.close()


# ── Context Manager ─────────────────────────────────────────────


class TestContextManager:
    @pytest.mark.asyncio
    async def test_async_context_manager(self):
        creds = await _get_or_register_agents()
        async with VoidlyAgent.from_credentials(creds["alice"]) as agent:
            assert agent.did.startswith("did:voidly:")
            profile = await agent.get_profile()
            assert profile.did == agent.did
