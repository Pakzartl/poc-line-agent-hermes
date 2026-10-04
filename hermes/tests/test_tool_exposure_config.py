from pathlib import Path
import sys

import yaml


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "hermes" / "smoke"))
import sessions_api_spike as spike  # noqa: E402

CONFIGS = [ROOT / "hermes" / "config.template.yaml", ROOT / "hermes" / "config.smoke.yaml"]
REQUIRED_DISABLED = {
    "terminal",
    "file",
    "browser",
    "web",
    "search",
    "memory",
    "session_search",
    "code_execution",
    "delegation",
    "cronjob",
    "connections",
    "computer_use",
    "image",
    "image_generation",
    "video",
    "video_generation",
    "tts",
    "x_search",
    "homeassistant",
    "kanban",
    "discord",
    "discord_admin",
    "feishu_doc",
    "feishu_drive",
    "spotify",
    "yuanbao",
    "skills",
}


def test_configs_pin_api_server_toolsets_and_disable_risky_defaults():
    for path in CONFIGS:
        cfg = parse_minimal_yaml(path)
        assert cfg["plugins"]["enabled"] == [
            "poc-line-agent-github",
            "poc-line-agent-skills-read",
        ]
        assert cfg["platform_toolsets"]["api_server"] == [
            "poc_line_agent_github",
            "poc_line_agent_skills_read",
            "no_mcp",
        ]
        assert cfg["known_plugin_toolsets"]["api_server"] == [
            "poc_line_agent_github",
            "poc_line_agent_skills_read",
        ]
        assert REQUIRED_DISABLED.issubset(set(cfg["agent"]["disabled_toolsets"]))
        guardrail = cfg["agent"]["system_prompt"]
        assert "latest user turn" in guardrail
        assert "bound by the runtime" in guardrail
        assert "Never infer, reuse, select, or override" in guardrail
        assert cfg["tools"]["tool_search"]["enabled"] in (False, "off")


def test_model_tool_exposure_rejects_excess_and_stock_skills_tools():
    snapshot = {
        "runtime_skill_requests": [
            {
                "tool_names": [
                    "list_repositories",
                    "github_get",
                    "search_code",
                    "read_file",
                    "get_commit",
                    "list_repo_skills",
                    "read_repo_skill",
                    "skill_manage",
                ]
            }
        ]
    }

    result = spike.evaluate_model_tool_exposure(snapshot)

    assert result["passed"] is False
    assert result["forbidden_tools"] == [
        "get_commit",
        "github_get",
        "list_repositories",
        "skill_manage",
    ]


def test_model_tool_exposure_accepts_exact_approved_tool_surface():
    snapshot = {
        "runtime_skill_requests": [
            {"tool_names": sorted(spike.APPROVED_MODEL_TOOLS)}
        ]
    }

    assert spike.evaluate_model_tool_exposure(snapshot)["passed"] is True


def parse_minimal_yaml(path):
    return yaml.safe_load(path.read_text())
