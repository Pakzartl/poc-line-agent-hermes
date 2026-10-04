import json
import os
import re
from pathlib import Path


MAX_SKILLS = 100
MAX_SKILL_CHARS = 20_000
SKILL_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$")


class SkillReadError(Exception):
    pass


def list_repo_skills(args=None, **kwargs):
    del args, kwargs
    return _safe_json(_list_repo_skills)


def read_repo_skill(args, **kwargs):
    del kwargs
    return _safe_json(lambda: _read_repo_skill(_require_exact(args, {"name"})["name"]))


def _safe_json(callback):
    try:
        return json.dumps({"ok": True, "data": callback()}, ensure_ascii=False)
    except Exception as exc:
        return json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False)


def _require_exact(args, allowed):
    if args is None:
        args = {}
    if not isinstance(args, dict):
        raise SkillReadError("tool arguments must be an object")
    extra = sorted(set(args) - allowed)
    if extra:
        raise SkillReadError(f"unsupported argument: {extra[0]}")
    missing = sorted(name for name in allowed if name not in args)
    if missing:
        raise SkillReadError(f"{missing[0]} is required")
    return args


def _skills_root():
    configured = os.environ.get("POC_LINE_AGENT_SKILLS_DIR", "").strip()
    if not configured:
        raise SkillReadError("POC_LINE_AGENT_SKILLS_DIR is required")
    root = Path(configured).expanduser()
    resolved = root.resolve(strict=True)
    if not resolved.is_dir():
        raise SkillReadError("POC_LINE_AGENT_SKILLS_DIR must be a directory")
    return resolved


def _list_repo_skills():
    root = _skills_root()
    skills = []
    for child in sorted(root.iterdir(), key=lambda path: path.name):
        if len(skills) >= MAX_SKILLS:
            break
        if not _is_direct_skill_dir(root, child):
            continue
        skill_md = _resolve_skill_file(root, child.name)
        body = _read_text_bounded(skill_md, 4_000)
        skills.append({
            "name": child.name,
            "description": _extract_description(body),
        })
    return {"root": str(root), "skills": skills, "truncated": len(skills) >= MAX_SKILLS}


def _read_repo_skill(name):
    skill_md = _resolve_skill_file(_skills_root(), name)
    safe_name = skill_md.parent.name
    body = _read_text_bounded(skill_md, MAX_SKILL_CHARS + 1)
    truncated = len(body) > MAX_SKILL_CHARS
    if truncated:
        body = body[:MAX_SKILL_CHARS] + "\n[truncated]"
    return {"name": safe_name, "content": body, "truncated": truncated}


def _normalize_skill_name(name):
    safe_name = str(name or "").strip()
    if not SKILL_NAME_RE.fullmatch(safe_name):
        raise SkillReadError("skill name must be an exact direct-child name")
    return safe_name


def _is_direct_skill_dir(root, child):
    if not child.is_dir() or child.is_symlink():
        return False
    try:
        child.resolve(strict=True).relative_to(root)
    except (OSError, ValueError):
        return False
    return (child / "SKILL.md").is_file() and not (child / "SKILL.md").is_symlink()


def _resolve_skill_file(root, name):
    safe_name = _normalize_skill_name(name)
    skill_dir = root / safe_name
    skill_file = skill_dir / "SKILL.md"
    if skill_dir.is_symlink() or skill_file.is_symlink():
        raise SkillReadError("skill symlinks are not allowed")
    try:
        resolved_dir = skill_dir.resolve(strict=True)
        resolved_file = skill_file.resolve(strict=True)
        resolved_dir.relative_to(root)
        resolved_file.relative_to(root)
    except (OSError, ValueError) as exc:
        raise SkillReadError("skill path escapes the configured root") from exc
    if resolved_file.parent != resolved_dir or not resolved_file.is_file():
        raise SkillReadError("skill not found")
    return resolved_file


def _read_text_bounded(path, max_chars):
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        return handle.read(max_chars)


def _extract_description(body):
    for line in body.splitlines():
        if line.startswith("description:"):
            return line.split(":", 1)[1].strip().strip('"')
    for line in body.splitlines():
        stripped = line.strip()
        if stripped and not stripped.startswith("---") and not stripped.startswith("name:"):
            return stripped[:200]
    return ""
