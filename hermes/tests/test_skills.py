from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SOURCE_SKILLS = ROOT / "src" / "skills"
HERMES_SKILLS = ROOT / "hermes" / "skills"


REPRESENTATIVE_ROUTING = {
    "repo-overview": ["repository purpose", "entry points", "deployment surface"],
    "code-scan": [
        "arbitrary codebase question",
        "runtime binds",
        "Never infer, reuse, select, or override",
        "all candidate",
        "not confirmed",
    ],
    "find-code": ["Locate the implementation", "definitions", "callers"],
    "pr-review": ["Pull Request Review", "correctness", "security"],
    "missing-tests": ["meaningful test gaps", "expected assertion"],
    "security-review": ["authentication", "authorization", "secret handling"],
    "config-explainer": ["environment variables", "secrets", "validation rules"],
    "repo-comparison": ["Compare implementation", "migration or reuse implications"],
    "risk-assessment": ["Assess implementation", "blast radius", "Human test plan"],
    "deploy": ["immutable 40-character commit SHA", "Do not deploy", "approval"],
}


def test_every_source_skill_has_hermes_skill_directory():
    source_names = sorted(path.stem for path in SOURCE_SKILLS.glob("*.md"))
    hermes_names = sorted(path.name for path in HERMES_SKILLS.iterdir() if path.is_dir())

    assert source_names
    assert hermes_names == source_names
    for name in source_names:
        skill = HERMES_SKILLS / name / "SKILL.md"
        body = skill.read_text()
        assert body.startswith("---\n")
        assert f"name: {name}" in body
        assert "version: 0.1.0" in body
        assert "metadata:" in body
        assert "requires_tools:" in body
        assert "# " in body


def test_representative_skill_routing_phrases_are_preserved():
    for name, phrases in REPRESENTATIVE_ROUTING.items():
        body = (HERMES_SKILLS / name / "SKILL.md").read_text()
        for phrase in phrases:
            assert phrase in body
