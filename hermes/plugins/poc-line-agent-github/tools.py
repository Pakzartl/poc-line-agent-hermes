import base64
import gzip
import io
import json
import os
import re
import tarfile
import urllib.error
import urllib.parse
import urllib.request
from collections import OrderedDict
from threading import Lock

MAX_SEARCH_RESULTS = 50
MAX_FILE_CHARS = 20_000
MAX_GITHUB_RESPONSE_BYTES = 750_000
MAX_ARCHIVE_BYTES = 96_000_000
MAX_INDEXED_CODE_BYTES = 16_000_000
MAX_SEARCHABLE_FILE_BYTES = 512_000
MAX_SEARCH_QUERIES = 12
MAX_SNIPPETS_PER_FILE = 3
MAX_COMPARE_COMMITS = 50
MAX_COMPARE_FILES = 100
MAX_PULL_REQUEST_FILES = 100
GITHUB_USER_AGENT = "poc-line-agent/0.1 hermes-plugin/0.1"
SOURCE_SCOPE_PREFIX = "POC_SOURCE_SCOPE_V1 "
MAX_SOURCE_SCOPES = 512
SCOPED_TOOLS = frozenset({"search_code", "read_file", "compare_refs", "get_pull_request"})
_SOURCE_SCOPES = OrderedDict()
_SOURCE_SCOPES_LOCK = Lock()


class GitHubToolError(Exception):
    pass


def search_code(args, **kwargs):
    del kwargs
    parsed = _require_exact(args, {"repository", "query", "branch"})
    return _safe_json(
        lambda: _search_code(parsed["repository"], parsed["query"], parsed["branch"])
    )


def read_file(args, **kwargs):
    del kwargs
    parsed = _require_exact(args, {"repository", "path", "branch"})
    return _safe_json(
        lambda: _read_file(parsed["repository"], parsed["path"], parsed["branch"])
    )


def compare_refs(args, **kwargs):
    del kwargs
    parsed = _require_args(
        args,
        required={"repository", "base", "head"},
        optional={"branch"},
    )
    return _safe_json(
        lambda: _compare_refs(parsed["repository"], parsed["base"], parsed["head"])
    )


def get_pull_request(args, **kwargs):
    del kwargs
    parsed = _require_args(
        args,
        required={"repository", "number"},
        optional={"branch"},
    )
    return _safe_json(
        lambda: _get_pull_request(
            parsed["repository"],
            parsed["number"],
            parsed.get("branch"),
        )
    )


def capture_source_scope(session_id="", turn_id="", user_message=None, **kwargs):
    del kwargs
    key = _scope_key(session_id, turn_id)
    if key is None:
        return None
    try:
        scope = _parse_source_scope(user_message)
    except GitHubToolError:
        scope = None
    with _SOURCE_SCOPES_LOCK:
        _SOURCE_SCOPES.pop(key, None)
        if scope is not None:
            _SOURCE_SCOPES[key] = scope
            while len(_SOURCE_SCOPES) > MAX_SOURCE_SCOPES:
                _SOURCE_SCOPES.popitem(last=False)
    return None


def bind_source_scope(tool_name="", args=None, session_id="", turn_id="", **kwargs):
    del args, kwargs
    if tool_name not in SCOPED_TOOLS:
        return None
    key = _scope_key(session_id, turn_id)
    with _SOURCE_SCOPES_LOCK:
        scope = _SOURCE_SCOPES.get(key) if key is not None else None
        if scope is not None:
            _SOURCE_SCOPES.move_to_end(key)
    if scope is None:
        return {
            "action": "block",
            "message": "Source scope is missing for this turn. Tell the Telegram user to start the code request with /code.",
        }
    return {"action": "modify", "args": dict(scope)}


def _safe_json(callback):
    try:
        return json.dumps({"ok": True, "data": callback()}, ensure_ascii=False)
    except Exception as exc:
        return json.dumps({"ok": False, "error": _redact(str(exc))}, ensure_ascii=False)


def _require_exact(args, allowed):
    return _require_args(args, required=allowed, optional=set())


def _require_args(args, required, optional):
    if args is None:
        args = {}
    if not isinstance(args, dict):
        raise GitHubToolError("tool arguments must be an object")
    allowed = set(required) | set(optional)
    extra = sorted(set(args) - allowed)
    if extra:
        raise GitHubToolError(f"unsupported argument: {extra[0]}")
    missing = sorted(name for name in required if name not in args)
    if missing:
        raise GitHubToolError(f"{missing[0]} is required")
    return args


def _config():
    token = os.environ.get("GITHUB_TOKEN", "").strip()
    if not token:
        raise GitHubToolError("GitHub token is required")
    api_base_url = os.environ.get("GITHUB_API_BASE_URL", "https://api.github.com").strip()
    parsed = urllib.parse.urlparse(api_base_url)
    if parsed.scheme != "https" or not parsed.netloc or parsed.params or parsed.query or parsed.fragment:
        raise GitHubToolError("GITHUB_API_BASE_URL must be an absolute HTTPS origin")
    return {
        "token": token,
        "api_base_url": api_base_url.rstrip("/"),
    }


def _request_json(path, validator=None):
    cfg = _config()
    validate = validator or _validate_read_path
    safe_path = validate(path)
    request = urllib.request.Request(
        f"{cfg['api_base_url']}{safe_path}",
        method="GET",
        headers=_github_headers(cfg["token"]),
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            if 300 <= response.status < 400:
                raise GitHubToolError("GitHub response redirect blocked")
            body = _read_bounded(response, MAX_GITHUB_RESPONSE_BYTES)
    except urllib.error.HTTPError as exc:
        if 300 <= exc.code < 400:
            raise GitHubToolError("GitHub response redirect blocked") from exc
        raise GitHubToolError(f"GitHub request failed with status {exc.code}") from exc
    try:
        return json.loads(body.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise GitHubToolError("GitHub response was not JSON") from exc


def _request_archive(repository, ref):
    cfg = _config()
    path = f"/repos/{repository}/tarball/{urllib.parse.quote(ref, safe='')}"
    url = f"{cfg['api_base_url']}{path}"
    request = urllib.request.Request(url, method="GET", headers=_github_headers(cfg["token"]))
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return _read_bounded(response, MAX_ARCHIVE_BYTES)
    except urllib.error.HTTPError as exc:
        if 300 <= exc.code < 400:
            location = exc.headers.get("location")
            if not location:
                raise GitHubToolError("GitHub archive redirect had no location") from exc
            redirect_url = urllib.parse.urljoin(url, location)
            if not _is_trusted_archive_redirect(cfg["api_base_url"], redirect_url):
                raise GitHubToolError("GitHub archive redirect was not trusted") from exc
            redirected = urllib.request.Request(
                redirect_url,
                method="GET",
                headers=_github_headers(cfg["token"]),
            )
            with urllib.request.urlopen(redirected, timeout=30) as response:
                return _read_bounded(response, MAX_ARCHIVE_BYTES)
        raise GitHubToolError(f"GitHub archive request failed with status {exc.code}") from exc


def _search_code(repository, query, branch):
    repo_path = _normalize_repository(repository)
    queries = _parse_search_queries(query)
    if not queries:
        return {"ok": False, "error": "query is required"}
    ref = _normalize_git_ref(branch)
    index = _build_branch_code_index(_request_archive(repo_path, ref))
    files = []
    matched_files = 0
    for entry in index["files"]:
        match = _match_file(entry["path"], entry["text"], queries)
        if not match:
            continue
        matched_files += 1
        if len(files) < MAX_SEARCH_RESULTS:
            match["url"] = _github_blob_url(repo_path, ref, match["path"])
            files.append(match)
    return {
        "repository": repo_path,
        "ref": ref,
        "queries": queries,
        "scannedFiles": index["scannedFiles"],
        "skippedLargeFiles": index["skippedLargeFiles"],
        "matchedFiles": matched_files,
        "indexReused": False,
        "truncated": matched_files > len(files),
        "files": files,
    }


def _read_file(repository, path, branch):
    repo_path = _normalize_repository(repository)
    safe_path = _normalize_repo_file_path(path)
    ref = _normalize_git_ref(branch)
    encoded_path = "/".join(urllib.parse.quote(part, safe="") for part in safe_path.split("/"))
    data = _request_json(f"/repos/{repo_path}/contents/{encoded_path}?ref={urllib.parse.quote(ref, safe='')}")
    if data.get("encoding") != "base64" or not data.get("content"):
        return {"ok": False, "error": "file content is not base64 text"}
    decoded = base64.b64decode(data["content"].replace("\n", "")).decode("utf-8", errors="replace")
    return {
        "repository": repo_path,
        "ref": ref,
        "path": data.get("path", safe_path),
        "size": data.get("size"),
        "content": _limit_text(decoded, MAX_FILE_CHARS),
    }


def _compare_refs(repository, base, head):
    repo_path = _normalize_repository(repository)
    base_ref = _normalize_git_ref(base)
    head_ref = _normalize_git_ref(head)
    data = _request_json(
        f"/repos/{repo_path}/compare/{urllib.parse.quote(base_ref, safe='')}...{urllib.parse.quote(head_ref, safe='')}",
        validator=_validate_metadata_read_path,
    )
    commits = data.get("commits") if isinstance(data.get("commits"), list) else []
    files = data.get("files") if isinstance(data.get("files"), list) else []
    return {
        "repository": repo_path,
        "base": base_ref,
        "head": head_ref,
        "status": data.get("status"),
        "aheadBy": data.get("ahead_by"),
        "behindBy": data.get("behind_by"),
        "totalCommits": data.get("total_commits"),
        "htmlUrl": data.get("html_url") or data.get("permalink_url"),
        "commitsTruncated": len(commits) > MAX_COMPARE_COMMITS,
        "filesTruncated": len(files) > MAX_COMPARE_FILES,
        "commits": [_summarize_commit(item) for item in commits[:MAX_COMPARE_COMMITS]],
        "files": [_summarize_changed_file(item) for item in files[:MAX_COMPARE_FILES]],
    }


def _get_pull_request(repository, number, bound_branch=None):
    repo_path = _normalize_repository(repository)
    pr_number = _normalize_positive_int(number, "number")
    pr = _request_json(
        f"/repos/{repo_path}/pulls/{pr_number}",
        validator=_validate_metadata_read_path,
    )
    files = _request_json(
        f"/repos/{repo_path}/pulls/{pr_number}/files?per_page={MAX_PULL_REQUEST_FILES}",
        validator=_validate_metadata_read_path,
    )
    if not isinstance(files, list):
        files = []
    base_ref = ((pr.get("base") or {}).get("ref")) if isinstance(pr.get("base"), dict) else None
    head = pr.get("head") if isinstance(pr.get("head"), dict) else {}
    head_ref = head.get("ref")
    head_repo = head.get("repo") if isinstance(head.get("repo"), dict) else {}
    bound_ref = _normalize_git_ref(bound_branch) if bound_branch else None
    return {
        "repository": repo_path,
        "number": pr_number,
        "title": pr.get("title"),
        "state": pr.get("state"),
        "draft": pr.get("draft"),
        "merged": pr.get("merged"),
        "htmlUrl": pr.get("html_url"),
        "baseRef": base_ref,
        "headRef": head_ref,
        "headRepository": head_repo.get("full_name"),
        "boundRef": bound_ref,
        "boundRefMatchesPullRequest": (
            bound_ref in {base_ref, head_ref} if bound_ref and (base_ref or head_ref) else None
        ),
        "author": (pr.get("user") or {}).get("login") if isinstance(pr.get("user"), dict) else None,
        "createdAt": pr.get("created_at"),
        "updatedAt": pr.get("updated_at"),
        "additions": pr.get("additions"),
        "deletions": pr.get("deletions"),
        "changedFiles": pr.get("changed_files"),
        "filesTruncated": (
            isinstance(pr.get("changed_files"), int) and pr.get("changed_files") > len(files)
        ),
        "files": [_summarize_changed_file(item) for item in files[:MAX_PULL_REQUEST_FILES]],
    }


def _github_headers(token):
    return {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
        "User-Agent": GITHUB_USER_AGENT,
        "X-GitHub-Api-Version": "2022-11-28",
    }


def _validate_read_path(path):
    trimmed = str(path).strip()
    if (
        not trimmed.startswith("/")
        or trimmed.startswith("//")
        or "\\" in trimmed
        or "#" in trimmed
    ):
        raise GitHubToolError("invalid GitHub GET path")
    parsed = urllib.parse.urlparse(trimmed)
    if parsed.scheme or parsed.netloc:
        raise GitHubToolError("invalid GitHub GET path")
    if not re.match(r"^/repos/[^/]+/[^/]+/contents/.+$", parsed.path):
        raise GitHubToolError("GitHub GET path is not a repository content read")
    query = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    if len(query) != 1 or query[0][0] != "ref" or not query[0][1]:
        raise GitHubToolError("GitHub content read requires exactly one ref")
    encoded_query = urllib.parse.urlencode(query)
    return f"{parsed.path}?{encoded_query}" if encoded_query else parsed.path


def _validate_metadata_read_path(path):
    trimmed = str(path).strip()
    if (
        not trimmed.startswith("/")
        or trimmed.startswith("//")
        or "\\" in trimmed
        or "#" in trimmed
    ):
        raise GitHubToolError("invalid GitHub metadata path")
    parsed = urllib.parse.urlparse(trimmed)
    if parsed.scheme or parsed.netloc or parsed.params or parsed.fragment:
        raise GitHubToolError("invalid GitHub metadata path")
    if re.match(r"^/repos/[^/]+/[^/]+/compare/[^/]+\.{3}[^/]+$", parsed.path):
        if parsed.query:
            raise GitHubToolError("GitHub compare read does not accept query parameters")
        return parsed.path
    if re.match(r"^/repos/[^/]+/[^/]+/pulls/[1-9][0-9]*$", parsed.path):
        if parsed.query:
            raise GitHubToolError("GitHub pull request read does not accept query parameters")
        return parsed.path
    if re.match(r"^/repos/[^/]+/[^/]+/pulls/[1-9][0-9]*/files$", parsed.path):
        query = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
        if query != [("per_page", str(MAX_PULL_REQUEST_FILES))]:
            raise GitHubToolError("GitHub pull request files read requires the bounded per_page parameter")
        return f"{parsed.path}?{urllib.parse.urlencode(query)}"
    raise GitHubToolError("GitHub metadata path is not an approved repository read")


def _scope_key(session_id, turn_id):
    session = str(session_id or "").strip()
    turn = str(turn_id or "").strip()
    return (session, turn) if session and turn else None


def _parse_source_scope(user_message):
    if not isinstance(user_message, str):
        raise GitHubToolError("source scope message must be text")
    first_line, separator, question = user_message.partition("\n\n")
    if not separator or not first_line.startswith(SOURCE_SCOPE_PREFIX) or not question.strip():
        raise GitHubToolError("source scope envelope is invalid")
    try:
        payload = json.loads(first_line[len(SOURCE_SCOPE_PREFIX):])
    except json.JSONDecodeError as exc:
        raise GitHubToolError("source scope envelope is invalid") from exc
    if not isinstance(payload, dict) or set(payload) != {"repository", "branch"}:
        raise GitHubToolError("source scope envelope is invalid")
    return {
        "repository": _normalize_repository(payload["repository"]),
        "branch": _normalize_git_ref(payload["branch"]),
    }


def _normalize_repository(repository):
    trimmed = str(repository).strip()
    if not re.match(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", trimmed):
        raise GitHubToolError("repository must use owner/name format")
    return trimmed


def _normalize_git_ref(ref):
    trimmed = str(ref or "").strip()[:200]
    if (
        not trimmed
        or trimmed.startswith("/")
        or trimmed.endswith("/")
        or ".." in trimmed
        or "@{" in trimmed
        or "\\" in trimmed
        or re.search(r"[\x00-\x20~^:?*\[\]]", trimmed)
    ):
        raise GitHubToolError("invalid GitHub ref")
    return trimmed


def _normalize_positive_int(value, name):
    if isinstance(value, bool):
        raise GitHubToolError(f"{name} must be a positive integer")
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise GitHubToolError(f"{name} must be a positive integer") from exc
    if parsed < 1:
        raise GitHubToolError(f"{name} must be a positive integer")
    return parsed


def _normalize_repo_file_path(path):
    trimmed = str(path).strip().lstrip("/")
    if not trimmed or ".." in trimmed.split("/"):
        raise GitHubToolError("invalid repository file path")
    return trimmed


def _is_trusted_archive_redirect(api_base_url, redirect_url):
    api_host = urllib.parse.urlparse(api_base_url).hostname
    redirect = urllib.parse.urlparse(redirect_url)
    return redirect.scheme == "https" and (
        redirect.hostname == api_host
        or (api_host == "api.github.com" and redirect.hostname == "codeload.github.com")
    )


def _build_branch_code_index(archive_bytes):
    raw = gzip.decompress(archive_bytes) if archive_bytes[:2] == b"\x1f\x8b" else archive_bytes
    files = []
    scanned_files = 0
    skipped_large_files = 0
    indexed_code_bytes = 0
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as tar:
        for member in tar:
            if not member.isfile():
                continue
            repo_path = _strip_archive_root(member.name)
            if not _is_searchable_code_path(repo_path):
                continue
            if member.size > MAX_SEARCHABLE_FILE_BYTES:
                skipped_large_files += 1
                continue
            extracted = tar.extractfile(member)
            if extracted is None:
                continue
            body = extracted.read()
            if b"\x00" in body:
                continue
            indexed_code_bytes += len(body)
            if indexed_code_bytes > MAX_INDEXED_CODE_BYTES:
                raise GitHubToolError("Repository code exceeded the branch search index limit")
            scanned_files += 1
            files.append({"path": repo_path, "text": body.decode("utf-8", errors="replace")})
    return {"scannedFiles": scanned_files, "skippedLargeFiles": skipped_large_files, "files": files}


def _match_file(path, text, queries):
    lower = text.lower()
    matched = [query for query in queries if query.lower() in lower]
    if not matched:
        return None
    snippets = []
    lower_queries = [query.lower() for query in matched]
    for index, line in enumerate(text.splitlines(), start=1):
        lower_line = line.lower()
        if any(query in lower_line for query in lower_queries):
            snippets.append({"line": index, "text": _limit_text(line.strip(), 300)})
            if len(snippets) >= MAX_SNIPPETS_PER_FILE:
                break
    return {"path": path, "matchedQueries": matched, "snippets": snippets}


def _parse_search_queries(query):
    seen = []
    for item in str(query).split("|"):
        value = item.strip()
        if value and value not in seen:
            seen.append(value[:100])
    return seen[:MAX_SEARCH_QUERIES]


def _strip_archive_root(path):
    return path.split("/", 1)[1] if "/" in path else path


def _is_searchable_code_path(path):
    if not path or re.search(r"(^|/)(node_modules|dist|build|coverage|vendor|\.git)(/|$)", path):
        return False
    return bool(
        re.search(
            r"(^|/)(Dockerfile|Makefile)$|\.(?:[cm]?[jt]sx?|json|ya?ml|toml|md|go|py|rb|java|kt|cs|php|rs|sh|graphql|gql|xml|conf|ini|env|tf|hcl|properties)$",
            path,
            re.IGNORECASE,
        )
    )


def _github_blob_url(repository, ref, path):
    return f"https://github.com/{repository}/blob/{urllib.parse.quote(ref, safe='')}/{'/'.join(urllib.parse.quote(part, safe='') for part in path.split('/'))}"


def _summarize_commit(commit):
    if not isinstance(commit, dict):
        return {}
    body = commit.get("commit") if isinstance(commit.get("commit"), dict) else {}
    author = body.get("author") if isinstance(body.get("author"), dict) else {}
    user = commit.get("author") if isinstance(commit.get("author"), dict) else {}
    message = str(body.get("message") or "").splitlines()[0][:240]
    return {
        "sha": commit.get("sha"),
        "message": message,
        "author": user.get("login") or author.get("name"),
        "date": author.get("date"),
        "htmlUrl": commit.get("html_url"),
    }


def _summarize_changed_file(item):
    if not isinstance(item, dict):
        return {}
    result = {
        "filename": item.get("filename"),
        "status": item.get("status"),
        "additions": item.get("additions"),
        "deletions": item.get("deletions"),
        "changes": item.get("changes"),
        "sha": item.get("sha"),
        "blobUrl": item.get("blob_url"),
        "rawUrl": item.get("raw_url"),
    }
    if item.get("previous_filename"):
        result["previousFilename"] = item.get("previous_filename")
    return result


def _read_bounded(response, max_bytes):
    content_length = response.headers.get("content-length")
    if content_length and int(content_length) > max_bytes:
        raise GitHubToolError("GitHub response exceeded the size limit")
    body = response.read(max_bytes + 1)
    if len(body) > max_bytes:
        raise GitHubToolError("GitHub response exceeded the size limit")
    return body


def _limit_text(text, max_chars):
    return text if len(text) <= max_chars else f"{text[:max_chars]}\n[truncated]"


def _redact(text):
    token = os.environ.get("GITHUB_TOKEN", "")
    if token:
        text = text.replace(token, "[redacted]")
    return re.sub(r"Bearer\s+[A-Za-z0-9._~+/=-]+", "Bearer [redacted]", text)
