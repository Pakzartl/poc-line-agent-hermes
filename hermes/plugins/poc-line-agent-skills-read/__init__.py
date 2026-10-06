from . import schemas, tools


def register(ctx):
    ctx.register_tool(
        name="list_repo_skills",
        toolset="poc_line_agent_skills_read",
        schema=schemas.LIST_REPO_SKILLS,
        handler=tools.list_repo_skills,
    )
    ctx.register_tool(
        name="read_repo_skill",
        toolset="poc_line_agent_skills_read",
        schema=schemas.READ_REPO_SKILL,
        handler=tools.read_repo_skill,
    )
