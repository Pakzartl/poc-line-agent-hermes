def _schema(name, description, properties=None, required=None):
    properties = properties or {}
    return {
        "name": name,
        "description": description,
        "parameters": {
            "type": "object",
            "properties": properties,
            "required": required or [],
            "additionalProperties": False,
        },
    }


SEARCH_CODE = _schema(
    "search_code",
    "Search source code inside the repository and branch bound to the current user turn. Separate literal alternatives with |.",
    {
        "query": {"type": "string", "description": "Code search query."},
    },
    ["query"],
)

READ_FILE = _schema(
    "read_file",
    "Read a bounded text file from the repository and branch bound to the current user turn.",
    {
        "path": {"type": "string", "description": "Repository-relative file path."},
    },
    ["path"],
)

COMPARE_REFS = _schema(
    "compare_refs",
    "Compare two refs inside the repository bound to the current user turn. Read-only; returns bounded commit and changed-file metadata.",
    {
        "base": {"type": "string", "description": "Base Git ref, branch, tag, or SHA."},
        "head": {"type": "string", "description": "Head Git ref, branch, tag, or SHA."},
    },
    ["base", "head"],
)

GET_PULL_REQUEST = _schema(
    "get_pull_request",
    "Read bounded pull request metadata and changed files from the repository bound to the current user turn.",
    {
        "number": {"type": "integer", "minimum": 1, "description": "Pull request number."},
    },
    ["number"],
)
