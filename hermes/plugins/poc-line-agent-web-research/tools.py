import importlib
import json
import re
import secrets
from collections import OrderedDict
from threading import Lock
from urllib.parse import urlparse

RESEARCH_SCOPE_PREFIX = "POC_WEB_RESEARCH_SCOPE_V1 "
RESEARCH_SESSION_PREFIX = "discord:research:"
SCOPED_TOOLS = frozenset({"search_public_web", "read_public_web"})
MAX_RESEARCH_SCOPES = 512
MAX_SEARCH_CALLS = 4
MAX_READ_CALLS = 3
MAX_QUERY_CHARS = 300
MAX_SEARCH_RESULTS = 8
MAX_READ_URLS = 3
MAX_EXTRACT_CHARS = 12_000
INTERNAL_SCOPE_HANDLE = "__javis_research_scope"

_RESEARCH_SCOPES = OrderedDict()
_RESEARCH_SCOPE_HANDLES = {}
_RESEARCH_SCOPES_LOCK = Lock()


class WebResearchToolError(Exception):
    pass


def capture_research_scope(session_id="", turn_id="", user_message=None, **kwargs):
    del kwargs
    key = _scope_key(session_id, turn_id)
    if key is None:
        return None
    try:
        scope = _parse_research_scope(session_id, user_message)
    except WebResearchToolError:
        scope = None
    with _RESEARCH_SCOPES_LOCK:
        _remove_scope_locked(key)
        if scope is not None:
            handle = secrets.token_urlsafe(32)
            scope["handle"] = handle
            _RESEARCH_SCOPES[key] = scope
            _RESEARCH_SCOPE_HANDLES[handle] = key
            while len(_RESEARCH_SCOPES) > MAX_RESEARCH_SCOPES:
                oldest_key = next(iter(_RESEARCH_SCOPES))
                _remove_scope_locked(oldest_key)
    return None


def require_research_scope(tool_name="", args=None, session_id="", turn_id="", **kwargs):
    del kwargs
    if tool_name not in SCOPED_TOOLS:
        return None
    key = _scope_key(session_id, turn_id)
    with _RESEARCH_SCOPES_LOCK:
        scope = _RESEARCH_SCOPES.get(key) if key is not None else None
        if scope is not None:
            _RESEARCH_SCOPES.move_to_end(key)
    if scope is None:
        return {
            "action": "block",
            "message": "Public web tools are available only in an isolated Javis research request.",
        }
    if args is not None and not isinstance(args, dict):
        return {
            "action": "block",
            "message": "Public web tool arguments must be an object.",
        }
    bound_args = dict(args or {})
    bound_args[INTERNAL_SCOPE_HANDLE] = scope["handle"]
    return {"action": "modify", "args": bound_args}


def search_public_web(args, **kwargs):
    del kwargs
    try:
        parsed, handle = _require_scoped_args(
            args,
            required={"query"},
            optional={"limit"},
        )
    except WebResearchToolError as exc:
        return _error(str(exc))
    query = str(parsed["query"]).strip()
    if not query or len(query) > MAX_QUERY_CHARS:
        return _error("query must contain 1 to 300 characters")
    try:
        limit = int(parsed.get("limit", 5))
    except (TypeError, ValueError):
        return _error("limit must be an integer")
    if limit < 1 or limit > MAX_SEARCH_RESULTS:
        return _error("limit must be between 1 and 8")
    scope = _consume_call(handle, "search_calls", MAX_SEARCH_CALLS)
    if scope is None:
        return _error("research scope is missing or the search-call limit was reached")
    try:
        result = _hermes_web_module().web_search_tool(query, limit=limit)
        payload = json.loads(result)
    except Exception as exc:
        return _error(_redact(str(exc)))
    urls = _search_result_urls(payload)
    _add_allowed_urls(handle, urls)
    return json.dumps(payload, ensure_ascii=False)


async def read_public_web(args, **kwargs):
    del kwargs
    try:
        parsed, handle = _require_scoped_args(
            args,
            required={"urls"},
            optional=set(),
        )
    except WebResearchToolError as exc:
        return _error(str(exc))
    urls = parsed["urls"]
    if not isinstance(urls, list) or not 1 <= len(urls) <= MAX_READ_URLS:
        return _error("urls must contain between 1 and 3 entries")
    normalized = []
    for value in urls:
        try:
            url = _normalize_public_https_url(value)
        except WebResearchToolError as exc:
            return _error(str(exc))
        if url in normalized:
            continue
        normalized.append(url)
    if not normalized:
        return _error("at least one unique URL is required")
    scope = _consume_call(handle, "read_calls", MAX_READ_CALLS)
    if scope is None:
        return _error("research scope is missing or the read-call limit was reached")
    if any(url not in scope["allowed_urls"] for url in normalized):
        return _error("every URL must come from search_public_web in the same research turn")
    try:
        result = await _hermes_web_module().web_extract_tool(
            normalized,
            format="markdown",
            char_limit=MAX_EXTRACT_CHARS,
        )
        return _bound_extract_result(result)
    except Exception as exc:
        return _error(_redact(str(exc)))


def _hermes_web_module():
    return importlib.import_module("tools.web_tools")


def _consume_call(handle, field, maximum):
    with _RESEARCH_SCOPES_LOCK:
        key, scope = _scope_for_handle_locked(handle)
        if scope is None or scope[field] >= maximum:
            return None
        scope[field] += 1
        _RESEARCH_SCOPES.move_to_end(key)
        return {
            **scope,
            "allowed_urls": set(scope["allowed_urls"]),
        }


def _add_allowed_urls(handle, urls):
    with _RESEARCH_SCOPES_LOCK:
        _, scope = _scope_for_handle_locked(handle)
        if scope is not None:
            scope["allowed_urls"].update(urls)


def _scope_for_handle_locked(handle):
    token = str(handle or "").strip()
    key = _RESEARCH_SCOPE_HANDLES.get(token)
    scope = _RESEARCH_SCOPES.get(key) if key is not None else None
    if scope is None or scope.get("handle") != token:
        if token:
            _RESEARCH_SCOPE_HANDLES.pop(token, None)
        return None, None
    return key, scope


def _remove_scope_locked(key):
    scope = _RESEARCH_SCOPES.pop(key, None)
    if scope is not None:
        _RESEARCH_SCOPE_HANDLES.pop(scope.get("handle"), None)


def _parse_research_scope(session_id, user_message):
    session = str(session_id or "").strip()
    if not session.startswith(RESEARCH_SESSION_PREFIX):
        raise WebResearchToolError("research session is invalid")
    if not isinstance(user_message, str):
        raise WebResearchToolError("research scope message must be text")
    first_line, separator, question = user_message.partition("\n\n")
    if not separator or not first_line.startswith(RESEARCH_SCOPE_PREFIX) or not question.strip():
        raise WebResearchToolError("research scope envelope is invalid")
    try:
        payload = json.loads(first_line[len(RESEARCH_SCOPE_PREFIX):])
    except json.JSONDecodeError as exc:
        raise WebResearchToolError("research scope envelope is invalid") from exc
    if not isinstance(payload, dict) or set(payload) != {"requestId"}:
        raise WebResearchToolError("research scope envelope is invalid")
    request_id = str(payload["requestId"] or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9._:-]{1,160}", request_id):
        raise WebResearchToolError("research request id is invalid")
    if session != f"{RESEARCH_SESSION_PREFIX}{request_id}":
        raise WebResearchToolError("research request does not match the session")
    return {
        "request_id": request_id,
        "search_calls": 0,
        "read_calls": 0,
        "allowed_urls": set(),
    }


def _scope_key(session_id, turn_id):
    session = str(session_id or "").strip()
    turn = str(turn_id or "").strip()
    return (session, turn) if session and turn else None


def _require_args(args, required, optional):
    if not isinstance(args, dict):
        raise WebResearchToolError("tool arguments must be an object")
    allowed = set(required) | set(optional)
    extra = sorted(set(args) - allowed)
    if extra:
        raise WebResearchToolError(f"unsupported argument: {extra[0]}")
    missing = sorted(name for name in required if name not in args)
    if missing:
        raise WebResearchToolError(f"{missing[0]} is required")
    return args


def _require_scoped_args(args, required, optional):
    if not isinstance(args, dict):
        raise WebResearchToolError("tool arguments must be an object")
    visible_args = dict(args)
    handle = str(visible_args.pop(INTERNAL_SCOPE_HANDLE, "") or "").strip()
    if not handle:
        raise WebResearchToolError("research scope is missing or invalid")
    return _require_args(visible_args, required, optional), handle


def _search_result_urls(payload):
    if not isinstance(payload, dict):
        return set()
    data = payload.get("data")
    entries = data.get("web") if isinstance(data, dict) else None
    if not isinstance(entries, list):
        return set()
    urls = set()
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        try:
            urls.add(_normalize_public_https_url(entry.get("url")))
        except WebResearchToolError:
            continue
    return urls


def _normalize_public_https_url(value):
    url = str(value or "").strip()
    parsed = urlparse(url)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.fragment
    ):
        raise WebResearchToolError("URLs must be credential-free public HTTPS URLs")
    return url


def _bound_extract_result(value):
    payload = json.loads(value)
    if not isinstance(payload, dict):
        raise WebResearchToolError("web extraction returned an invalid response")
    entries = payload.get("results")
    if not isinstance(entries, list):
        return _error(_redact(str(payload.get("error") or "web extraction failed")))
    bounded = []
    for entry in entries[:MAX_READ_URLS]:
        if not isinstance(entry, dict):
            continue
        bounded.append({
            "url": str(entry.get("url") or "")[:2_048],
            "title": str(entry.get("title") or "")[:500],
            "content": str(entry.get("content") or "")[:MAX_EXTRACT_CHARS],
            "error": _redact(str(entry.get("error") or "")),
        })
    return json.dumps({"results": bounded}, ensure_ascii=False)


def _error(message):
    return json.dumps({"success": False, "error": message}, ensure_ascii=False)


def _redact(value):
    return re.sub(r"(?i)(token|secret|key)=?[^\s&]+", r"\1=[redacted]", value)[:500]
