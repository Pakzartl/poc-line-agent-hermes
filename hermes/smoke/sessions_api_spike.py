#!/usr/bin/env python3
import argparse
import json
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


DEFAULT_BASE_URL = "http://127.0.0.1:8642"
DEFAULT_API_KEY = "local-smoke-api-key-0000000000000000"
DEFAULT_COMPOSE_FILES = [
    "hermes/compose.yaml",
    "hermes/compose.local.yaml",
    "hermes/compose.fake-openai.yaml",
]
APPROVED_PLUGIN_TOOLSETS = {"poc_line_agent_github", "poc_line_agent_skills_read"}
NO_TOOL_SENTINELS = {"no_mcp"}
APPROVED_MODEL_TOOLS = {
    "search_code",
    "read_file",
    "compare_refs",
    "get_pull_request",
    "list_repo_skills",
    "read_repo_skill",
}
FORBIDDEN_MODEL_TOOLS = {
    "list_repositories",
    "github_get",
    "get_commit",
    "skill_manage",
    "skill_view",
    "skills_list",
    "execute_shell",
    "run_shell",
    "terminal",
    "write_file",
    "edit_file",
    "browser_navigate",
    "web_search",
    "memory_write",
    "mcp_call",
}


class Client:
    def __init__(self, base_url, api_key, timeout=60):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout

    def health(self):
        return self.request("GET", "/health", auth=False)

    def capabilities(self):
        return self.request("GET", "/v1/capabilities")

    def skills(self):
        return self.request("GET", "/v1/skills", allow_error=True)

    def toolsets(self):
        return self.request("GET", "/v1/toolsets")

    def chat(self, session_id, text):
        return self.request("POST", f"/api/sessions/{quote_session_id(session_id)}/chat", {"input": text})

    def create_session(self, session_id, source):
        return self.request("POST", "/api/sessions", {"id": session_id, "source": source}, allow_error=True)

    def messages(self, session_id):
        return self.request("GET", f"/api/sessions/{quote_session_id(session_id)}/messages")

    def request(self, method, path, body=None, auth=True, allow_error=False):
        data = None if body is None else json.dumps(body).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if auth:
            headers["Authorization"] = f"Bearer {self.api_key}"
        request = urllib.request.Request(f"{self.base_url}{path}", data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                raw = response.read().decode("utf-8")
                return {"status": response.status, "body": parse_json(raw), "raw": raw}
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace")
            if allow_error:
                return {"status": exc.code, "body": parse_json(raw), "raw": raw}
            raise RuntimeError(f"{method} {path} failed with HTTP {exc.code}: {raw}") from exc


def quote_session_id(session_id):
    if not session_id or "/" in session_id:
        raise ValueError("session id must be non-empty and must not contain /")
    return urllib.parse.quote(session_id, safe="")


def parse_json(raw):
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


def normalize_messages(payload):
    if isinstance(payload, dict):
        body = payload.get("body", payload)
        if isinstance(body, dict):
            messages = body.get("messages", body.get("data", []))
        else:
            messages = []
    else:
        messages = payload
    return messages if isinstance(messages, list) else []


def message_text(message):
    content = message.get("content")
    if isinstance(content, str):
        return content
    return json.dumps(content, sort_keys=True)


def has_stable_ordering_metadata(messages):
    normalized = normalize_messages(messages)
    if not normalized:
        return False
    for message in normalized:
        if not message.get("role") or "content" not in message:
            return False
        if not (message.get("id") or message.get("created_at") or message.get("timestamp")):
            return False
    return True


def contains_text(messages, text):
    return any(text in message_text(message) for message in normalize_messages(messages))


def has_assistant_after_user(messages, user_text):
    seen_user = False
    for message in normalize_messages(messages):
        if message.get("role") == "user" and user_text in message_text(message):
            seen_user = True
            continue
        if seen_user and message.get("role") == "assistant" and message_text(message):
            return True
    return False


def ordered_signature(messages, max_content_chars=None):
    signature = []
    for message in normalize_messages(messages):
        content = message_text(message)
        if max_content_chars is not None and len(content) > max_content_chars:
            content = content[:max_content_chars] + "…"
        signature.append({
            "id": message.get("id"),
            "created_at": message.get("created_at") or message.get("timestamp"),
            "role": message.get("role"),
            "content": content,
        })
    return signature


def wait_for_health(client, timeout_seconds):
    deadline = time.monotonic() + timeout_seconds
    last_error = None
    while time.monotonic() < deadline:
        try:
            health = client.health()
            if health["status"] == 200:
                return health
        except Exception as exc:
            last_error = str(exc)
        time.sleep(1)
    raise RuntimeError(f"Hermes health did not become ready within {timeout_seconds}s; last error: {last_error}")


def run_compose_restart(compose_files, service):
    command = compose_command(compose_files, "restart", service)
    completed = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    return {
        "command": command,
        "returncode": completed.returncode,
        "stdout": completed.stdout.strip(),
        "stderr": completed.stderr.strip(),
    }


def run_compose_logs(compose_files, service, tail):
    command = compose_command(compose_files, "logs", "--tail", str(tail), service)
    completed = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    return {
        "command": command,
        "returncode": completed.returncode,
        "stdout": completed.stdout,
        "stderr": completed.stderr,
    }


def run_spike(args):
    client = Client(args.base_url, args.api_key, timeout=args.request_timeout)
    result = {
        "passed": False,
        "sessions_spike_passed": False,
        "skills_api_passed": False,
        "runtime_skill_usage_passed": False,
        "canary_blockers": [],
        "warnings": [],
        "checks": {},
        "started_at": datetime.now(timezone.utc).isoformat(),
        "base_url": args.base_url,
    }

    result["checks"]["health_before"] = wait_for_health(client, args.health_timeout)
    result["checks"]["capabilities"] = client.capabilities()
    toolsets = client.toolsets()
    toolset_summary = summarize_toolsets(toolsets)
    result["checks"]["toolsets"] = {
        "status": toolsets["status"],
        **toolset_summary,
    }
    result["checks"]["converted_skill_files"] = {
        "path": "hermes/skills",
        "count": len(list(Path("hermes/skills").glob("*/SKILL.md"))),
    }
    if not result["checks"]["toolsets"]["approved_plugin_toolsets_loaded"]:
        result["canary_blockers"].append("approved plugin toolsets were not both reported enabled by /v1/toolsets")
        return result
    if result["checks"]["toolsets"]["excess_enabled_toolsets"]:
        result["canary_blockers"].append(
            "unapproved toolsets are enabled: "
            + ", ".join(result["checks"]["toolsets"]["excess_enabled_toolsets"])
        )
        return result
    if result["checks"]["converted_skill_files"]["count"] < 1:
        result["canary_blockers"].append("no converted SKILL.md files found under hermes/skills")
        return result

    run_id = str(int(time.time() * 1000))
    session_a = "telegram:chat:1001"
    session_b = "line:user:u-1001"
    text_a = f"spike-a-{run_id}"
    text_b = f"spike-b-{run_id}"

    result["sessions"] = {"a": session_a, "b": session_b, "text_a": text_a, "text_b": text_b}
    create_a = client.create_session(session_a, "telegram")
    create_b = client.create_session(session_b, "line")
    result["checks"]["create_sessions"] = {"a": create_a, "b": create_b}
    for label, create_result in (("a", create_a), ("b", create_b)):
        if create_result["status"] not in (201, 409):
            result["canary_blockers"].append(
                f"create session {label} failed with HTTP {create_result['status']}: {create_result['raw'][:300]}"
            )
            return result

    result["checks"]["chat_a"] = client.chat(session_a, text_a)
    result["checks"]["chat_b"] = client.chat(session_b, text_b)

    before_a = client.messages(session_a)
    before_b = client.messages(session_b)
    result["checks"]["messages_before_restart"] = {
        "a": ordered_signature(before_a),
        "b": ordered_signature(before_b),
    }

    before_isolation = (
        contains_text(before_a, text_a)
        and not contains_text(before_b, text_a)
        and contains_text(before_b, text_b)
        and not contains_text(before_a, text_b)
    )
    before_retrieval = (
        has_stable_ordering_metadata(before_a)
        and has_stable_ordering_metadata(before_b)
        and has_assistant_after_user(before_a, text_a)
        and has_assistant_after_user(before_b, text_b)
    )

    restart = run_compose_restart(args.compose_file, args.service)
    result["checks"]["restart"] = restart
    if restart["returncode"] != 0:
        result["canary_blockers"].append(f"compose restart failed: {restart['stderr'] or restart['stdout']}")
        return result

    result["checks"]["health_after"] = wait_for_health(client, args.health_timeout)
    after_a = client.messages(session_a)
    after_b = client.messages(session_b)
    result["checks"]["messages_after_restart"] = {
        "a": ordered_signature(after_a),
        "b": ordered_signature(after_b),
    }

    after_isolation = (
        contains_text(after_a, text_a)
        and not contains_text(after_b, text_a)
        and contains_text(after_b, text_b)
        and not contains_text(after_a, text_b)
    )
    after_persistence = (
        contains_text(after_a, text_a)
        and contains_text(after_b, text_b)
        and has_stable_ordering_metadata(after_a)
        and has_stable_ordering_metadata(after_b)
        and has_assistant_after_user(after_a, text_a)
        and has_assistant_after_user(after_b, text_b)
    )

    result["checks"]["session_assertions"] = {
        "before_isolation": before_isolation,
        "before_retrieval_ordering_assistant": before_retrieval,
        "after_isolation": after_isolation,
        "after_restart_persistence_ordering_assistant": after_persistence,
    }
    result["sessions_spike_passed"] = all(result["checks"]["session_assertions"].values())

    skill_session = "runtime:skill-smoke"
    skill_prompt = (
        "runtime-skill-smoke: use poc-line-agent read-only skill tools to list skills, "
        "then read the repo-overview skill, then answer with the proof marker."
    )
    skill_create = client.create_session(skill_session, "smoke")
    result["checks"]["runtime_skill_session_create"] = skill_create
    if skill_create["status"] not in (201, 409):
        result["canary_blockers"].append(
            f"create runtime skill session failed with HTTP {skill_create['status']}: {skill_create['raw'][:300]}"
        )
        return result
    skill_chat = client.chat(skill_session, skill_prompt)
    skill_messages = client.messages(skill_session)
    result["checks"]["runtime_skill_usage"] = {
        "chat_status": skill_chat["status"],
        "assistant_content": ((skill_chat.get("body") or {}).get("message") or {}).get("content"),
        "messages": ordered_signature(skill_messages, max_content_chars=1200),
    }
    result["runtime_skill_usage_passed"] = (
        skill_chat["status"] == 200
        and "runtime-skill-smoke-ok" in str(((skill_chat.get("body") or {}).get("message") or {}).get("content") or "")
        and contains_text(skill_messages, "runtime-skill-smoke-ok")
    )
    fake_snapshot = run_fake_request_snapshot(args.compose_file)
    if fake_snapshot is not None:
        result["checks"]["fake_model_request_snapshot"] = fake_snapshot
        exposure = evaluate_model_tool_exposure(fake_snapshot)
        result["checks"]["model_tool_exposure"] = exposure
        if not exposure["passed"]:
            result["canary_blockers"].append(
                "model request exposed unapproved tools: "
                + ", ".join(exposure["excess_tools"] + exposure["forbidden_tools"])
            )
            return result
    if not result["runtime_skill_usage_passed"]:
        result["canary_blockers"].append("Hermes runtime skill tool usage did not prove repo-overview was readable")
        return result

    skills = client.skills()
    result["checks"]["skills_endpoint"] = {
        "status": skills["status"],
        "body": skills["body"],
        "raw_snippet": skills["raw"][:500],
    }
    result["skills_api_passed"] = skills["status"] == 200
    if not result["skills_api_passed"]:
        logs = run_compose_logs(args.compose_file, args.service, tail=200)
        result["checks"]["skills_endpoint_logs"] = {
            "returncode": logs["returncode"],
            "stdout_snippet": logs["stdout"][-4000:],
            "stderr_snippet": logs["stderr"][-1000:],
        }
        if "_find_all_skills() got an unexpected keyword argument 'include_editorial'" in logs["stdout"]:
            result["warnings"].append(
                "Hermes v0.21.5 /v1/skills endpoint returns 500 due upstream _find_all_skills(include_editorial=...) TypeError; stock skills toolset is disabled and poc-line-agent read-only skill tools passed"
            )
        else:
            result["canary_blockers"].append(f"/v1/skills returned HTTP {skills['status']}")

    result["passed"] = (
        result["sessions_spike_passed"]
        and result["runtime_skill_usage_passed"]
        and not result["canary_blockers"]
    )
    return result


def summarize_toolsets(toolsets):
    data = (toolsets.get("body") or {}).get("data", [])
    enabled = []
    tools_by_enabled_toolset = {}
    for item in data if isinstance(data, list) else []:
        if not isinstance(item, dict) or not item.get("enabled"):
            continue
        name = str(item.get("name") or "")
        enabled.append(name)
        tools_by_enabled_toolset[name] = sorted(str(tool) for tool in item.get("tools", []) if tool)
    enabled_set = set(enabled)
    excess = sorted(enabled_set - APPROVED_PLUGIN_TOOLSETS - NO_TOOL_SENTINELS)
    approved_tools = sorted({
        tool
        for name, tools in tools_by_enabled_toolset.items()
        if name in APPROVED_PLUGIN_TOOLSETS
        for tool in tools
    })
    return {
        "enabled_toolsets": sorted(enabled),
        "approved_plugin_toolsets_loaded": APPROVED_PLUGIN_TOOLSETS.issubset(enabled_set),
        "excess_enabled_toolsets": excess,
        "approved_tools": approved_tools,
    }


def evaluate_model_tool_exposure(snapshot):
    requests = snapshot.get("runtime_skill_requests") or []
    observed = sorted({
        name
        for request in requests
        for name in request.get("tool_names", [])
        if name
    })
    observed_set = set(observed)
    excess = sorted(observed_set - APPROVED_MODEL_TOOLS)
    forbidden = sorted(observed_set & FORBIDDEN_MODEL_TOOLS)
    missing = sorted(APPROVED_MODEL_TOOLS - observed_set)
    return {
        "passed": bool(requests) and not excess and not forbidden and not missing,
        "approved_tools": sorted(APPROVED_MODEL_TOOLS),
        "observed_tools": observed,
        "excess_tools": excess,
        "forbidden_tools": forbidden,
        "missing_approved_tools": missing,
    }


def run_fake_request_snapshot(compose_files):
    code = r"""
import json
import urllib.request

data = json.load(urllib.request.urlopen("http://127.0.0.1:8080/requests"))
matching = []
for request in data.get("requests", []):
    messages = request.get("messages", [])
    if any("runtime-skill-smoke" in str(message.get("content_snippet", "")) for message in messages):
        tool_names = [tool.get("name") for tool in request.get("tools", []) if tool.get("name")]
        matching.append({
            "path": request.get("path"),
            "stream": request.get("stream"),
            "system_prompt_contains_hermes": any(
                message.get("role") == "system" and "Hermes Agent" in str(message.get("content_snippet", ""))
                for message in messages
            ),
            "read_only_skill_tool_schemas_seen": all(name in tool_names for name in ("list_repo_skills", "read_repo_skill")),
            "tool_names": tool_names,
            "roles": [message.get("role") for message in messages],
        })
print(json.dumps({"runtime_skill_requests": matching}))
"""
    command = compose_command(
        compose_files,
        "exec",
        "-T",
        "fake-openai",
        "python3",
        "-c",
        code,
    )
    completed = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if completed.returncode != 0:
        return {
            "available": False,
            "stderr_snippet": completed.stderr[-500:],
            "stdout_snippet": completed.stdout[-500:],
        }
    try:
        parsed = json.loads(completed.stdout)
    except json.JSONDecodeError:
        return {"available": False, "stdout_snippet": completed.stdout[-500:]}
    parsed["available"] = True
    return parsed


def compose_command(compose_files, *args):
    command = ["docker", "compose"]
    for compose_file in compose_files:
        command.extend(["-f", compose_file])
    command.extend(args)
    return command


def main():
    parser = argparse.ArgumentParser(description="Credential-free Hermes Sessions API smoke spike")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--api-key", default=DEFAULT_API_KEY)
    parser.add_argument("--service", default="hermes")
    parser.add_argument("--compose-file", action="append", default=None)
    parser.add_argument("--health-timeout", type=int, default=90)
    parser.add_argument("--request-timeout", type=int, default=90)
    args = parser.parse_args()
    if args.compose_file is None:
        args.compose_file = DEFAULT_COMPOSE_FILES

    try:
        result = run_spike(args)
    except Exception as exc:
        result = {
            "passed": False,
            "sessions_spike_passed": False,
            "skills_api_passed": False,
            "runtime_skill_usage_passed": False,
            "canary_blockers": [str(exc)],
            "warnings": [],
            "checks": {},
        }
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result.get("passed") else 1


if __name__ == "__main__":
    sys.exit(main())
