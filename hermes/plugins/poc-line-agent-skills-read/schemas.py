def _schema(name, description, properties=None, required=None):
    return {
        "name": name,
        "description": description,
        "parameters": {
            "type": "object",
            "properties": properties or {},
            "required": required or [],
            "additionalProperties": False,
        },
    }


LIST_REPO_SKILLS = _schema(
    "list_repo_skills",
    "List mounted poc-line-agent skill names and first-line descriptions. Read-only and deterministic.",
)

READ_REPO_SKILL = _schema(
    "read_repo_skill",
    "Read one mounted poc-line-agent SKILL.md by exact direct-child skill name. Read-only and bounded.",
    {
        "name": {
            "type": "string",
            "description": "Exact skill directory name under POC_LINE_AGENT_SKILLS_DIR, for example repo-overview.",
        }
    },
    ["name"],
)
