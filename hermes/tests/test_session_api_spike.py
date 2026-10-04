import io
import json
import pathlib
import sys

import session_api_spike as spike

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "smoke"))
import fake_openai  # noqa: E402
import sessions_api_spike as smoke_spike  # noqa: E402


def test_quote_session_id_rejects_slash_and_encodes_colons():
    assert spike.quote_session_id("telegram:chat:1001") == "telegram%3Achat%3A1001"
    try:
        spike.quote_session_id("bad/session")
    except ValueError as exc:
        assert "must not contain /" in str(exc)
    else:
        raise AssertionError("slash-containing session id should fail")


def test_client_uses_sessions_api_without_session_key_header():
    requests = []

    def opener(request, timeout):
        requests.append((request, timeout))
        return FakeHttpResponse({"messages": []})

    client = spike.HermesSessionClient("http://127.0.0.1:8642", "api-secret", opener=opener)
    client.create_session("telegram:chat:1001", "telegram")
    client.chat("telegram:chat:1001", "hello")
    client.messages("telegram:chat:1001")

    assert requests[0][0].full_url.endswith("/api/sessions")
    assert requests[0][0].data == b'{"id": "telegram:chat:1001", "source": "telegram"}'
    assert requests[1][0].full_url.endswith("/api/sessions/telegram%3Achat%3A1001/chat")
    assert requests[1][0].data == b'{"input": "hello"}'
    assert requests[0][0].get_header("Authorization") == "Bearer api-secret"
    assert requests[0][0].get_header("X-hermes-session-key") is None
    assert requests[2][0].get_method() == "GET"


def test_recovery_predicate_requires_one_matching_user_then_assistant():
    messages = [
        {"id": "1", "role": "user", "content": "before"},
        {"id": "2", "role": "assistant", "content": "old"},
        {"id": "3", "role": "user", "content": "target"},
        {"id": "4", "role": "assistant", "content": "answer"},
    ]

    assert spike.find_recoverable_assistant(messages, "2", "target") == messages[3]
    assert spike.find_recoverable_assistant(messages + [{"id": "5", "role": "user", "content": "target"}], "2", "target") is None
    assert spike.find_recoverable_assistant(messages[:3], "2", "target") is None


def test_message_metadata_contract():
    assert spike.has_ordering_metadata([
        {"id": "1", "role": "user", "content": "hi"},
        {"created_at": "2026-10-01T00:00:00Z", "role": "assistant", "content": "ok"},
    ])
    assert not spike.has_ordering_metadata([{"role": "user", "content": "missing id"}])


def test_restart_persistence_predicate_requires_before_messages_after_restart():
    before = [
        {"id": "1", "role": "user", "content": "first"},
        {"id": "2", "role": "assistant", "content": "reply"},
    ]
    after = [
        {"id": "1", "role": "user", "content": "first"},
        {"id": "2", "role": "assistant", "content": "reply"},
        {"id": "3", "role": "user", "content": "after restart"},
    ]

    assert spike.evaluate_restart_persistence(before, after)
    assert not spike.evaluate_restart_persistence(before, after[1:])


def test_smoke_spike_detects_ordering_isolation_and_assistant_reply():
    messages_a = [
        {"id": "1", "role": "user", "content": "spike-a", "created_at": "2026-10-01T00:00:00Z"},
        {"id": "2", "role": "assistant", "content": "fake-hermes-response: spike-a", "created_at": "2026-10-01T00:00:01Z"},
    ]
    messages_b = [
        {"id": "1", "role": "user", "content": "spike-b", "created_at": "2026-10-01T00:00:00Z"},
        {"id": "2", "role": "assistant", "content": "fake-hermes-response: spike-b", "created_at": "2026-10-01T00:00:01Z"},
    ]

    assert smoke_spike.has_stable_ordering_metadata(messages_a)
    assert smoke_spike.has_assistant_after_user(messages_a, "spike-a")
    assert smoke_spike.contains_text(messages_a, "spike-a")
    assert not smoke_spike.contains_text(messages_b, "spike-a")


def test_fake_openai_response_is_deterministic_from_last_user_message():
    messages = [
        {"role": "user", "content": "first"},
        {"role": "assistant", "content": "ignored"},
        {"role": "user", "content": "second"},
    ]

    assert fake_openai.deterministic_response(messages) == "fake-hermes-response: second"
    assert fake_openai.stable_id("chatcmpl", "same") == fake_openai.stable_id("chatcmpl", "same")


def test_isolation_observation_shape():
    a_messages = [{"id": "1", "role": "user", "content": "unique-a"}]
    b_messages = [{"id": "1", "role": "user", "content": "unique-b"}]

    assert "unique-a" in json.dumps(a_messages)
    assert "unique-a" not in json.dumps(b_messages)


class FakeHttpResponse:
    def __init__(self, payload):
        self.payload = payload

    def read(self):
        return json.dumps(self.payload).encode()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False
