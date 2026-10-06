import asyncio
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PLUGIN = ROOT / "hermes" / "plugins" / "poc-line-agent-web-research"


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, PLUGIN / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


schemas = load_module("poc_web_research_schemas", "schemas.py")
tools = load_module("poc_web_research_tools", "tools.py")


class FakeWebTools:
    def __init__(self):
        self.searches = []
        self.reads = []

    def web_search_tool(self, query, limit=5):
        self.searches.append((query, limit))
        return json.dumps({
            "success": True,
            "data": {
                "web": [
                    {
                        "title": "Official warning",
                        "url": "https://example.go.th/warning?id=1",
                        "description": "Current warning",
                        "position": 1,
                    }
                ]
            },
        })

    async def web_extract_tool(self, urls, format=None, char_limit=None):
        self.reads.append((urls, format, char_limit))
        return json.dumps({"results": [{"url": urls[0], "content": "warning body"}]})


def bind_scope(session_id="discord:research:req-1", turn_id="turn-1"):
    tools._RESEARCH_SCOPES.clear()
    tools._RESEARCH_SCOPE_HANDLES.clear()
    tools.capture_research_scope(
        session_id=session_id,
        turn_id=turn_id,
        user_message='POC_WEB_RESEARCH_SCOPE_V1 {"requestId":"req-1"}\n\nquestion',
    )


def runtime_args(tool_name, args, session_id="discord:research:req-1", turn_id="turn-1"):
    directive = tools.require_research_scope(
        tool_name=tool_name,
        args=args,
        session_id=session_id,
        turn_id=turn_id,
    )
    assert directive["action"] == "modify"
    assert directive["args"][tools.INTERNAL_SCOPE_HANDLE]
    return directive["args"]


def test_schemas_are_bounded_and_do_not_expose_scope_arguments():
    assert schemas.SEARCH_PUBLIC_WEB["name"] == "search_public_web"
    assert schemas.READ_PUBLIC_WEB["name"] == "read_public_web"
    assert schemas.SEARCH_PUBLIC_WEB["parameters"]["additionalProperties"] is False
    assert schemas.READ_PUBLIC_WEB["parameters"]["properties"]["urls"]["maxItems"] == 3
    for schema in [schemas.SEARCH_PUBLIC_WEB, schemas.READ_PUBLIC_WEB]:
        assert "session_id" not in schema["parameters"]["properties"]
        assert "requestId" not in schema["parameters"]["properties"]
        assert tools.INTERNAL_SCOPE_HANDLE not in schema["parameters"]["properties"]


def test_scope_requires_matching_isolated_session_and_envelope():
    bind_scope()
    directive = tools.require_research_scope(
        tool_name="search_public_web",
        args={"query": "warning"},
        session_id="discord:research:req-1",
        turn_id="turn-1",
    )
    assert directive["action"] == "modify"
    assert directive["args"]["query"] == "warning"
    assert directive["args"][tools.INTERNAL_SCOPE_HANDLE]
    blocked = tools.require_research_scope(
        tool_name="search_public_web",
        session_id="discord:channel:guild:channel:user",
        turn_id="turn-1",
    )
    assert blocked["action"] == "block"

    bind_scope(session_id="discord:research:other")
    blocked = tools.require_research_scope(
        tool_name="search_public_web",
        session_id="discord:research:other",
        turn_id="turn-1",
    )
    assert blocked["action"] == "block"


def test_search_then_read_only_urls_from_same_turn(monkeypatch):
    fake = FakeWebTools()
    monkeypatch.setattr(tools, "_hermes_web_module", lambda: fake)
    bind_scope()

    search = json.loads(tools.search_public_web(runtime_args(
        "search_public_web",
        {"query": "flood warning Nan 10 October 2026", "limit": 5},
    )))
    assert search["success"] is True
    assert fake.searches == [("flood warning Nan 10 October 2026", 5)]

    read = json.loads(asyncio.run(tools.read_public_web(runtime_args(
        "read_public_web",
        {"urls": ["https://example.go.th/warning?id=1"]},
    ))))
    assert read["results"][0]["content"] == "warning body"
    assert fake.reads == [
        (["https://example.go.th/warning?id=1"], "markdown", 12_000)
    ]

    rejected = json.loads(asyncio.run(tools.read_public_web(runtime_args(
        "read_public_web",
        {"urls": ["https://unsearched.example/story"]},
    ))))
    assert rejected["success"] is False
    assert "same research turn" in rejected["error"]


def test_call_budget_is_bounded(monkeypatch):
    fake = FakeWebTools()
    monkeypatch.setattr(tools, "_hermes_web_module", lambda: fake)
    bind_scope()
    for index in range(4):
        result = json.loads(tools.search_public_web(runtime_args(
            "search_public_web",
            {"query": f"query {index}"},
        )))
        assert result["success"] is True
    result = json.loads(tools.search_public_web(runtime_args(
        "search_public_web",
        {"query": "query 5"},
    )))
    assert result["success"] is False
    assert "limit" in result["error"]


def test_invalid_tool_arguments_fail_closed():
    bind_scope()

    missing_query = json.loads(tools.search_public_web(runtime_args(
        "search_public_web",
        {},
    )))
    assert missing_query == {"success": False, "error": "query is required"}

    unsupported_argument = json.loads(tools.search_public_web(runtime_args(
        "search_public_web",
        {"query": "warning", "scope": "all"},
    )))
    assert unsupported_argument == {
        "success": False,
        "error": "unsupported argument: scope",
    }

    invalid_url = json.loads(asyncio.run(tools.read_public_web(runtime_args(
        "read_public_web",
        {"urls": ["http://example.com/story"]},
    ))))
    assert invalid_url == {
        "success": False,
        "error": "URLs must be credential-free public HTTPS URLs",
    }


def test_extracted_content_is_bounded(monkeypatch):
    fake = FakeWebTools()

    async def oversized_extract(urls, format=None, char_limit=None):
        del format, char_limit
        return json.dumps({
            "results": [{
                "url": urls[0],
                "title": "T" * 700,
                "content": "C" * 20_000,
                "error": "",
                "unexpected": "must not reach the model",
            }]
        })

    fake.web_extract_tool = oversized_extract
    monkeypatch.setattr(tools, "_hermes_web_module", lambda: fake)
    bind_scope()
    tools.search_public_web(runtime_args("search_public_web", {"query": "warning"}))

    result = json.loads(asyncio.run(tools.read_public_web(runtime_args(
        "read_public_web",
        {"urls": ["https://example.go.th/warning?id=1"]},
    ))))
    assert len(result["results"][0]["content"]) == 12_000
    assert len(result["results"][0]["title"]) == 500
    assert "unexpected" not in result["results"][0]


def test_tool_handlers_require_runtime_injected_scope_handle(monkeypatch):
    fake = FakeWebTools()
    monkeypatch.setattr(tools, "_hermes_web_module", lambda: fake)
    bind_scope()

    result = json.loads(tools.search_public_web({"query": "warning"}))

    assert result == {
        "success": False,
        "error": "research scope is missing or invalid",
    }
    assert fake.searches == []


def test_hook_overwrites_model_supplied_scope_handle():
    bind_scope()

    args = runtime_args(
        "search_public_web",
        {"query": "warning", tools.INTERNAL_SCOPE_HANDLE: "attacker-controlled"},
    )

    assert args[tools.INTERNAL_SCOPE_HANDLE] != "attacker-controlled"


def test_recapturing_scope_invalidates_previous_handle(monkeypatch):
    fake = FakeWebTools()
    monkeypatch.setattr(tools, "_hermes_web_module", lambda: fake)
    bind_scope()
    stale_args = runtime_args("search_public_web", {"query": "warning"})

    tools.capture_research_scope(
        session_id="discord:research:req-1",
        turn_id="turn-1",
        user_message='POC_WEB_RESEARCH_SCOPE_V1 {"requestId":"req-1"}\n\nnew question',
    )
    result = json.loads(tools.search_public_web(stale_args))

    assert result["success"] is False
    assert "research scope is missing" in result["error"]
    assert fake.searches == []
