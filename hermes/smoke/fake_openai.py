#!/usr/bin/env python3
import hashlib
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


MODEL_ID = "fake-hermes-model"
REQUESTS = []


class FakeOpenAIHandler(BaseHTTPRequestHandler):
    server_version = "FakeOpenAI/0.1"

    def do_GET(self):
        if self.path == "/health":
            self._send_json({"status": "ok"})
            return
        if self.path == "/requests":
            self._send_json({"requests": REQUESTS[-20:]})
            return
        if self.path in ("/v1/models", "/api/v1/models"):
            self._send_json({
                "object": "list",
                "data": [
                    {
                        "id": MODEL_ID,
                        "object": "model",
                        "created": 0,
                        "owned_by": "local-smoke",
                    }
                ],
            })
            return
        if self.path == f"/v1/models/{MODEL_ID}":
            self._send_json({
                "id": MODEL_ID,
                "object": "model",
                "created": 0,
                "owned_by": "local-smoke",
                "context_length": 256000,
            })
            return
        if self.path == "/api/tags":
            self._send_json({"models": [{"name": MODEL_ID, "model": MODEL_ID}]})
            return
        if self.path in ("/v1/props", "/props"):
            self._send_json({"context_length": 256000})
            return
        if self.path == "/version":
            self._send_json({"version": "local-smoke"})
            return
        self._send_json({"error": {"message": f"unknown path {self.path}"}}, status=404)

    def do_POST(self):
        try:
            payload = self._read_json()
        except json.JSONDecodeError as exc:
            self._send_json({"error": {"message": f"invalid json: {exc}"}}, status=400)
            return

        if self.path == "/v1/chat/completions":
            self._handle_chat_completions(payload)
            return
        if self.path == "/v1/responses":
            self._handle_responses(payload)
            return
        if self.path == "/api/show":
            self._send_json({"model": MODEL_ID, "parameters": {"num_ctx": 256000}})
            return
        self._send_json({"error": {"message": f"unknown path {self.path}"}}, status=404)

    def log_message(self, fmt, *args):
        sys.stdout.write("%s - %s\n" % (self.log_date_time_string(), fmt % args))
        sys.stdout.flush()

    def _handle_chat_completions(self, payload):
        record_request(self.path, payload)
        tool_call = planned_skill_tool_call(payload.get("messages", []), payload.get("tools", []))
        if tool_call is not None:
            if payload.get("stream"):
                self._send_tool_call_stream(payload, tool_call)
                return
            self._send_json({
                "id": stable_id("chatcmpl", json.dumps(tool_call, sort_keys=True)),
                "object": "chat.completion",
                "created": int(time.time()),
                "model": payload.get("model") or MODEL_ID,
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": None, "tool_calls": [tool_call]},
                        "finish_reason": "tool_calls",
                    }
                ],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            })
            return
        response_text = deterministic_response(payload.get("messages", []))
        if payload.get("stream"):
            self._send_chat_stream(payload, response_text)
            return

        self._send_json({
            "id": stable_id("chatcmpl", response_text),
            "object": "chat.completion",
            "created": int(time.time()),
            "model": payload.get("model") or MODEL_ID,
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": response_text},
                    "finish_reason": "stop",
                }
            ],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        })

    def _handle_responses(self, payload):
        record_request(self.path, payload)
        text = payload.get("input")
        if isinstance(text, list):
            text = json.dumps(text, sort_keys=True)
        response_text = f"fake-hermes-response: {text or ''}"
        self._send_json({
            "id": stable_id("resp", response_text),
            "object": "response",
            "created_at": int(time.time()),
            "model": payload.get("model") or MODEL_ID,
            "status": "completed",
            "output": [
                {
                    "id": stable_id("msg", response_text),
                    "type": "message",
                    "status": "completed",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": response_text}],
                }
            ],
            "output_text": response_text,
            "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2},
        })

    def _send_chat_stream(self, payload, response_text):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()

        chunk_id = stable_id("chatcmpl", response_text)
        model = payload.get("model") or MODEL_ID
        chunks = [
            {"id": chunk_id, "object": "chat.completion.chunk", "created": int(time.time()), "model": model, "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}]},
            {"id": chunk_id, "object": "chat.completion.chunk", "created": int(time.time()), "model": model, "choices": [{"index": 0, "delta": {"content": response_text}, "finish_reason": None}]},
            {"id": chunk_id, "object": "chat.completion.chunk", "created": int(time.time()), "model": model, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
        ]
        for chunk in chunks:
            self.wfile.write(f"data: {json.dumps(chunk, separators=(',', ':'))}\n\n".encode())
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def _send_tool_call_stream(self, payload, tool_call):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()

        chunk_id = stable_id("chatcmpl", json.dumps(tool_call, sort_keys=True))
        model = payload.get("model") or MODEL_ID
        function = tool_call["function"]
        chunks = [
            {
                "id": chunk_id,
                "object": "chat.completion.chunk",
                "created": int(time.time()),
                "model": model,
                "choices": [
                    {
                        "index": 0,
                        "delta": {
                            "role": "assistant",
                            "tool_calls": [
                                {
                                    "index": 0,
                                    "id": tool_call["id"],
                                    "type": "function",
                                    "function": {"name": function["name"], "arguments": ""},
                                }
                            ],
                        },
                        "finish_reason": None,
                    }
                ],
            },
            {
                "id": chunk_id,
                "object": "chat.completion.chunk",
                "created": int(time.time()),
                "model": model,
                "choices": [
                    {
                        "index": 0,
                        "delta": {
                            "tool_calls": [
                                {"index": 0, "function": {"arguments": function["arguments"]}}
                            ]
                        },
                        "finish_reason": None,
                    }
                ],
            },
            {
                "id": chunk_id,
                "object": "chat.completion.chunk",
                "created": int(time.time()),
                "model": model,
                "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}],
            },
        ]
        for chunk in chunks:
            self.wfile.write(f"data: {json.dumps(chunk, separators=(',', ':'))}\n\n".encode())
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def _read_json(self):
        length = int(self.headers.get("Content-Length") or "0")
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8") or "{}")

    def _send_json(self, payload, status=200):
        raw = json.dumps(payload, sort_keys=True).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


def deterministic_response(messages):
    if is_runtime_skill_smoke(messages):
        tool_contents = "\n".join(
            str(message.get("content") or "")
            for message in messages or []
            if isinstance(message, dict) and message.get("role") == "tool"
        )
        if "repo-overview" in tool_contents and "Repository Overview" in tool_contents:
            return "runtime-skill-smoke-ok: repo-overview skill was listed and read through poc-line-agent read-only skill tools"
        compact = " ".join(tool_contents.split())[:900]
        return f"runtime-skill-smoke-failed: expected repo-overview skill tool output was not observed; tool_output={compact}"

    last_user = ""
    for message in messages or []:
        if isinstance(message, dict) and message.get("role") == "user":
            content = message.get("content")
            if isinstance(content, list):
                last_user = json.dumps(content, sort_keys=True)
            else:
                last_user = str(content or "")
    return f"fake-hermes-response: {last_user}"


def planned_skill_tool_call(messages, tools):
    if not is_runtime_skill_smoke(messages):
        return None
    tool_names = {
        ((tool.get("function") or {}).get("name"))
        for tool in tools or []
        if isinstance(tool, dict)
    }
    tool_messages = [
        message for message in messages or []
        if isinstance(message, dict) and message.get("role") == "tool"
    ]
    tool_text = "\n".join(str(message.get("content") or "") for message in tool_messages)

    if "list_repo_skills" in tool_names and len(tool_messages) == 0:
        return make_tool_call("list_repo_skills", {})
    if (
        "read_repo_skill" in tool_names
        and "Repository Overview" not in tool_text
        and len(tool_messages) == 1
    ):
        return make_tool_call("read_repo_skill", {"name": "repo-overview"})
    return None


def make_tool_call(name, arguments):
    return {
        "id": f"call_{stable_id(name, json.dumps(arguments, sort_keys=True))[-16:]}",
        "type": "function",
        "function": {"name": name, "arguments": json.dumps(arguments, sort_keys=True)},
    }


def is_runtime_skill_smoke(messages):
    return any(
        isinstance(message, dict)
        and message.get("role") == "user"
        and "runtime-skill-smoke" in str(message.get("content") or "")
        for message in messages or []
    )


def record_request(path, payload):
    tools = []
    for tool in payload.get("tools") or []:
        if isinstance(tool, dict):
            function = tool.get("function") or {}
            tools.append({
                "type": tool.get("type"),
                "name": function.get("name"),
                "parameters": function.get("parameters"),
            })
    REQUESTS.append({
        "path": path,
        "stream": bool(payload.get("stream")),
        "tool_choice": payload.get("tool_choice"),
        "tools": tools,
        "messages": [
            {
                "role": message.get("role"),
                "name": message.get("name"),
                "tool_call_id": message.get("tool_call_id"),
                "content_snippet": str(message.get("content"))[:500],
            }
            for message in payload.get("messages", [])
            if isinstance(message, dict)
        ],
    })


def stable_id(prefix, text):
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]
    return f"{prefix}-{digest}"


def main():
    host = os.environ.get("FAKE_OPENAI_HOST", "0.0.0.0")
    port = int(os.environ.get("FAKE_OPENAI_PORT", "8080"))
    server = ThreadingHTTPServer((host, port), FakeOpenAIHandler)
    print(f"fake OpenAI-compatible server listening on {host}:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
