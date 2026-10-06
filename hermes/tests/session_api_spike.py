import json
import time
import urllib.parse
import urllib.request


class HermesSessionClient:
    def __init__(self, base_url, api_key, opener=None):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.opener = opener or urllib.request.urlopen

    def chat(self, session_id, text):
        return self._request("POST", f"/api/sessions/{quote_session_id(session_id)}/chat", {"input": text})

    def create_session(self, session_id, source="smoke"):
        return self._request("POST", "/api/sessions", {"id": session_id, "source": source})

    def messages(self, session_id):
        return self._request("GET", f"/api/sessions/{quote_session_id(session_id)}/messages", None)

    def _request(self, method, path, body):
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=data,
            method=method,
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
        )
        with self.opener(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))


def quote_session_id(session_id):
    if "/" in session_id or not session_id:
        raise ValueError("session id must be non-empty and must not contain /")
    return urllib.parse.quote(session_id, safe="")


def has_ordering_metadata(messages):
    normalized = normalize_messages(messages)
    if not normalized:
        return False
    for message in normalized:
        if not message.get("role") or "content" not in message:
            return False
        if not (message.get("id") or message.get("created_at") or message.get("timestamp")):
            return False
    return True


def normalize_messages(payload):
    if isinstance(payload, dict):
        messages = payload.get("messages", [])
    else:
        messages = payload
    return messages if isinstance(messages, list) else []


def find_recoverable_assistant(messages, baseline_message_id, user_content):
    normalized = normalize_messages(messages)
    after_baseline = baseline_message_id is None
    matches = []
    for index, message in enumerate(normalized):
        if not after_baseline:
            after_baseline = message.get("id") == baseline_message_id
            continue
        if message.get("role") == "user" and message.get("content") == user_content:
            matches.append(index)
    if len(matches) != 1:
        return None
    for message in normalized[matches[0] + 1 :]:
        if message.get("role") == "user":
            return None
        if message.get("role") == "assistant" and message.get("content"):
            return message
    return None


def run_spike(base_url, api_key):
    client = HermesSessionClient(base_url, api_key)
    session_a = "telegram:chat:1001"
    session_b = "line:user:u-1001"
    unique_a = f"spike-a-{int(time.time())}"
    unique_b = f"spike-b-{int(time.time())}"

    client.chat(session_a, unique_a)
    client.chat(session_b, unique_b)
    messages_a = client.messages(session_a)
    messages_b = client.messages(session_b)

    text_a = json.dumps(messages_a)
    text_b = json.dumps(messages_b)
    return {
        "isolation": unique_a in text_a and unique_a not in text_b and unique_b in text_b and unique_b not in text_a,
        "retrieval_metadata": has_ordering_metadata(messages_a) and has_ordering_metadata(messages_b),
        "restart_persistence": None,
        "session_a": session_a,
        "session_b": session_b,
    }


def evaluate_restart_persistence(before_restart, after_restart):
    before = normalize_messages(before_restart)
    after = normalize_messages(after_restart)
    before_ids = {message.get("id") for message in before if message.get("id")}
    after_ids = {message.get("id") for message in after if message.get("id")}
    if before_ids:
        return before_ids.issubset(after_ids) and has_ordering_metadata(after)
    before_contents = [(message.get("role"), message.get("content")) for message in before]
    after_contents = [(message.get("role"), message.get("content")) for message in after]
    return all(item in after_contents for item in before_contents) and has_ordering_metadata(after)
