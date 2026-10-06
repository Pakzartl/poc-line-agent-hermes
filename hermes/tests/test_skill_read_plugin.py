import importlib.util
import json
import os
from pathlib import Path


PLUGIN_DIR = Path(__file__).resolve().parents[1] / "plugins" / "poc-line-agent-skills-read"


def load_module(name):
    spec = importlib.util.spec_from_file_location(name, PLUGIN_DIR / f"{name.rsplit('_', 1)[-1]}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


tools = load_module("skill_read_tools")
schemas = load_module("skill_read_schemas")


def decode(result):
    return json.loads(result)


def make_skill(root, name, body):
    skill_dir = root / name
    skill_dir.mkdir()
    (skill_dir / "SKILL.md").write_text(body, encoding="utf-8")
    return skill_dir


def test_schemas_are_read_only_and_exact():
    names = [schemas.LIST_REPO_SKILLS["name"], schemas.READ_REPO_SKILL["name"]]

    assert names == ["list_repo_skills", "read_repo_skill"]
    assert "write" not in json.dumps([schemas.LIST_REPO_SKILLS, schemas.READ_REPO_SKILL]).lower()
    for schema in [schemas.LIST_REPO_SKILLS, schemas.READ_REPO_SKILL]:
        assert schema["parameters"]["additionalProperties"] is False


def test_list_and_read_repo_skill_from_exact_direct_child(tmp_path, monkeypatch):
    make_skill(
        tmp_path,
        "repo-overview",
        "---\nname: repo-overview\ndescription: Build an evidence-backed orientation.\n---\n\n# Repository Overview\n",
    )
    monkeypatch.setenv("POC_LINE_AGENT_SKILLS_DIR", str(tmp_path))

    listed = decode(tools.list_repo_skills())
    read = decode(tools.read_repo_skill({"name": "repo-overview"}))

    assert listed["ok"] is True
    assert listed["data"]["skills"] == [
        {"name": "repo-overview", "description": "Build an evidence-backed orientation."}
    ]
    assert read["ok"] is True
    assert read["data"]["name"] == "repo-overview"
    assert "# Repository Overview" in read["data"]["content"]


def test_read_repo_skill_rejects_traversal_and_extra_args(tmp_path, monkeypatch):
    make_skill(tmp_path, "repo-overview", "# Repository Overview\n")
    monkeypatch.setenv("POC_LINE_AGENT_SKILLS_DIR", str(tmp_path))

    assert decode(tools.read_repo_skill({"name": "../repo-overview"}))["ok"] is False
    assert decode(tools.read_repo_skill({"name": "repo-overview/../x"}))["ok"] is False
    assert decode(tools.read_repo_skill({"name": "repo-overview", "path": "SKILL.md"}))["ok"] is False


def test_read_repo_skill_blocks_symlink_escape(tmp_path, monkeypatch):
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "SKILL.md").write_text("# Secret\n", encoding="utf-8")
    root = tmp_path / "root"
    root.mkdir()
    os.symlink(outside, root / "escaped")
    monkeypatch.setenv("POC_LINE_AGENT_SKILLS_DIR", str(root))

    listed = decode(tools.list_repo_skills())
    read = decode(tools.read_repo_skill({"name": "escaped"}))

    assert listed["ok"] is True
    assert listed["data"]["skills"] == []
    assert read["ok"] is False


def test_read_repo_skill_bounds_output(tmp_path, monkeypatch):
    make_skill(tmp_path, "large", "x" * (tools.MAX_SKILL_CHARS + 500))
    monkeypatch.setenv("POC_LINE_AGENT_SKILLS_DIR", str(tmp_path))

    result = decode(tools.read_repo_skill({"name": "large"}))

    assert result["ok"] is True
    assert result["data"]["truncated"] is True
    assert result["data"]["content"].endswith("[truncated]")
    assert len(result["data"]["content"]) <= tools.MAX_SKILL_CHARS + len("\n[truncated]")
