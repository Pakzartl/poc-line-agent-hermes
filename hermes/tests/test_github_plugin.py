import base64
import gzip
import io
import json
import tarfile
import urllib.error

import schemas
import tools


def decode(result):
    return json.loads(result)


def test_schemas_expose_only_read_only_tools():
    names = [
        schemas.SEARCH_CODE["name"],
        schemas.READ_FILE["name"],
        schemas.COMPARE_REFS["name"],
        schemas.GET_PULL_REQUEST["name"],
    ]

    assert names == ["search_code", "read_file", "compare_refs", "get_pull_request"]
    for schema in [
        schemas.SEARCH_CODE,
        schemas.READ_FILE,
        schemas.COMPARE_REFS,
        schemas.GET_PULL_REQUEST,
    ]:
        params = schema["parameters"]
        assert params["additionalProperties"] is False


def test_code_read_schemas_do_not_allow_the_model_to_select_source_scope():
    for schema in [schemas.SEARCH_CODE, schemas.READ_FILE, schemas.COMPARE_REFS, schemas.GET_PULL_REQUEST]:
        params = schema["parameters"]
        assert "repository" not in params["properties"]
        assert "branch" not in params["properties"]
        assert "bound to the current user turn" in schema["description"]


def test_turn_scope_hook_overwrites_model_source_and_fails_closed_without_scope():
    tools._SOURCE_SCOPES.clear()
    message = (
        'POC_SOURCE_SCOPE_V1 {"repository":"acme/api","branch":"dev"}'
        "\n\nfind the rate limiter"
    )

    tools.capture_source_scope(
        session_id="telegram:chat:1",
        turn_id="turn-1",
        user_message=message,
    )

    assert tools.bind_source_scope(
        tool_name="search_code",
        args={"query": "Throttle", "repository": "evil/repo", "branch": "main"},
        session_id="telegram:chat:1",
        turn_id="turn-1",
    ) == {
        "action": "modify",
        "args": {"repository": "acme/api", "branch": "dev"},
    }
    missing = tools.bind_source_scope(
        tool_name="read_file",
        args={"path": "src/app.ts"},
        session_id="telegram:chat:1",
        turn_id="other-turn",
    )
    assert missing["action"] == "block"


def test_invalid_scope_envelope_cannot_reuse_an_older_turn_scope():
    tools._SOURCE_SCOPES.clear()
    tools.capture_source_scope(
        session_id="telegram:chat:1",
        turn_id="turn-1",
        user_message=(
            'POC_SOURCE_SCOPE_V1 {"repository":"acme/api","branch":"dev"}'
            "\n\nquestion"
        ),
    )
    tools.capture_source_scope(
        session_id="telegram:chat:1",
        turn_id="turn-1",
        user_message="question without an envelope",
    )

    result = tools.bind_source_scope(
        tool_name="search_code",
        args={"query": "x"},
        session_id="telegram:chat:1",
        turn_id="turn-1",
    )

    assert result["action"] == "block"


def test_read_file_validates_path_and_truncates(monkeypatch):
    def fake_request_json(path):
        assert path == "/repos/acme/api/contents/src/app.ts?ref=dev"
        return {
            "path": "src/app.ts",
            "size": 25_000,
            "encoding": "base64",
            "content": base64.b64encode(("x" * 25_000).encode()).decode(),
        }

    monkeypatch.setenv("GITHUB_TOKEN", "secret-token")
    monkeypatch.setattr(tools, "_request_json", fake_request_json)

    result = decode(tools.read_file({
        "repository": "acme/api",
        "path": "src/app.ts",
        "branch": "dev",
    }))

    assert result["ok"] is True
    assert result["data"]["content"].endswith("[truncated]")
    assert len(result["data"]["content"]) < 20_100
    assert decode(tools.read_file({
        "repository": "acme/api",
        "path": "../secret",
        "branch": "dev",
    }))["ok"] is False


def test_search_code_scans_archive_and_bounds_queries(monkeypatch):
    monkeypatch.setenv("GITHUB_TOKEN", "secret-token")
    monkeypatch.setattr(tools, "_request_archive", lambda repository, ref: make_tar_gz({
        "acme-api/src/auth/login.ts": "Throttle login\nexport const x = 1;",
        "acme-api/node_modules/skip.js": "Throttle",
    }))

    result = decode(tools.search_code({
        "repository": "acme/api",
        "query": "Throttle|missing",
        "branch": "chore/seed-pichya-user",
    }))

    assert result["ok"] is True
    assert result["data"]["matchedFiles"] == 1
    assert result["data"]["ref"] == "chore/seed-pichya-user"
    assert result["data"]["files"][0]["path"] == "src/auth/login.ts"
    assert result["data"]["files"][0]["matchedQueries"] == ["Throttle"]


def test_api_errors_are_mapped_and_tokens_are_redacted(monkeypatch):
    def fake_urlopen(request, timeout):
        raise urllib.error.HTTPError(request.full_url, 403, "token secret-token rejected", {}, None)

    monkeypatch.setenv("GITHUB_TOKEN", "secret-token")
    monkeypatch.setattr(tools.urllib.request, "urlopen", fake_urlopen)

    result = decode(tools.read_file({
        "repository": "acme/api",
        "path": "src/app.ts",
        "branch": "dev",
    }))

    assert result == {"ok": False, "error": "GitHub request failed with status 403"}
    assert "secret-token" not in json.dumps(result)


def test_archive_redirect_must_stay_on_trusted_github_host(monkeypatch):
    monkeypatch.setenv("GITHUB_TOKEN", "secret-token")
    assert tools._is_trusted_archive_redirect("https://api.github.com", "https://codeload.github.com/acme/api")
    assert not tools._is_trusted_archive_redirect("https://api.github.com", "https://example.com/acme/api")


def test_compare_refs_reads_bounded_metadata_from_bound_repository(monkeypatch):
    seen = []

    def fake_request_json(path, validator=None):
        seen.append(validator(path))
        return {
            "status": "ahead",
            "ahead_by": 2,
            "behind_by": 0,
            "total_commits": 2,
            "html_url": "https://github.com/acme/api/compare/main...dev",
            "commits": [
                {
                    "sha": "abc123",
                    "html_url": "https://github.com/acme/api/commit/abc123",
                    "commit": {
                        "message": "add rate limit\n\nbody",
                        "author": {"name": "Ada", "date": "2026-10-01T00:00:00Z"},
                    },
                    "author": {"login": "ada"},
                }
            ],
            "files": [
                {
                    "filename": "src/app.ts",
                    "status": "modified",
                    "additions": 4,
                    "deletions": 2,
                    "changes": 6,
                    "sha": "file-sha",
                    "blob_url": "https://github.com/acme/api/blob/dev/src/app.ts",
                    "raw_url": "https://raw.githubusercontent.com/acme/api/dev/src/app.ts",
                    "patch": "@@ secret patch omitted",
                }
            ],
        }

    monkeypatch.setenv("GITHUB_TOKEN", "secret-token")
    monkeypatch.setattr(tools, "_request_json", fake_request_json)

    result = decode(tools.compare_refs({
        "repository": "acme/api",
        "branch": "dev",
        "base": "main",
        "head": "feature/rate-limit",
    }))

    assert result["ok"] is True
    assert seen == ["/repos/acme/api/compare/main...feature%2Frate-limit"]
    assert result["data"]["commits"][0]["message"] == "add rate limit"
    assert result["data"]["files"][0]["filename"] == "src/app.ts"
    assert "patch" not in result["data"]["files"][0]


def test_get_pull_request_reads_pr_and_changed_files_without_exposing_source_scope(monkeypatch):
    def fake_request_json(path, validator=None):
        safe_path = validator(path)
        if safe_path.endswith("/pulls/42"):
            return {
                "number": 42,
                "title": "Risky change",
                "state": "open",
                "draft": False,
                "merged": False,
                "html_url": "https://github.com/acme/api/pull/42",
                "base": {"ref": "main"},
                "head": {"ref": "dev", "repo": {"full_name": "acme/api"}},
                "user": {"login": "ada"},
                "created_at": "2026-10-01T00:00:00Z",
                "updated_at": "2026-10-02T00:00:00Z",
                "additions": 10,
                "deletions": 1,
                "changed_files": 1,
            }
        assert safe_path.endswith("/pulls/42/files?per_page=100")
        return [{"filename": "src/app.ts", "status": "modified", "changes": 11}]

    monkeypatch.setenv("GITHUB_TOKEN", "secret-token")
    monkeypatch.setattr(tools, "_request_json", fake_request_json)

    result = decode(tools.get_pull_request({
        "repository": "acme/api",
        "branch": "dev",
        "number": 42,
    }))

    assert result["ok"] is True
    assert result["data"]["baseRef"] == "main"
    assert result["data"]["headRef"] == "dev"
    assert result["data"]["boundRefMatchesPullRequest"] is True
    assert result["data"]["files"] == [{
        "filename": "src/app.ts",
        "status": "modified",
        "additions": None,
        "deletions": None,
        "changes": 11,
        "sha": None,
        "blobUrl": None,
        "rawUrl": None,
    }]


def test_metadata_path_validator_blocks_unapproved_github_reads():
    assert tools._validate_metadata_read_path("/repos/acme/api/pulls/1") == "/repos/acme/api/pulls/1"
    assert decode(tools.get_pull_request({
        "repository": "acme/api",
        "branch": "dev",
        "number": 0,
    }))["ok"] is False
    try:
        tools._validate_metadata_read_path("/repos/acme/api/issues/1")
    except tools.GitHubToolError as exc:
        assert "approved repository read" in str(exc)
    else:
        raise AssertionError("expected unapproved metadata path to be blocked")


def make_tar_gz(files):
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w") as tar:
        for path, content in files.items():
            encoded = content.encode()
            info = tarfile.TarInfo(path)
            info.size = len(encoded)
            tar.addfile(info, io.BytesIO(encoded))
    return gzip.compress(raw.getvalue())
