import os
from pathlib import Path

from . import schemas, tools


def register(ctx):
    ctx.register_tool(
        name="search_code",
        toolset="poc_line_agent_github",
        schema=schemas.SEARCH_CODE,
        handler=tools.search_code,
    )
    ctx.register_tool(
        name="read_file",
        toolset="poc_line_agent_github",
        schema=schemas.READ_FILE,
        handler=tools.read_file,
    )
    ctx.register_tool(
        name="compare_refs",
        toolset="poc_line_agent_github",
        schema=schemas.COMPARE_REFS,
        handler=tools.compare_refs,
    )
    ctx.register_tool(
        name="get_pull_request",
        toolset="poc_line_agent_github",
        schema=schemas.GET_PULL_REQUEST,
        handler=tools.get_pull_request,
    )
    ctx.register_hook("pre_api_request", tools.capture_source_scope)
    ctx.register_hook("pre_tool_call", tools.bind_source_scope)

    skills_dir = Path(
        os.environ.get("POC_LINE_AGENT_SKILLS_DIR", Path(__file__).parent / "skills")
    )
    if skills_dir.exists():
        for child in sorted(skills_dir.iterdir()):
            skill_md = child / "SKILL.md"
            if child.is_dir() and skill_md.exists():
                ctx.register_skill(child.name, skill_md)
