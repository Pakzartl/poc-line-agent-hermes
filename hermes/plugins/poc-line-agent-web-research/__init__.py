from . import schemas, tools


def register(ctx):
    ctx.register_tool(
        name="search_public_web",
        toolset="poc_line_agent_web_research",
        schema=schemas.SEARCH_PUBLIC_WEB,
        handler=tools.search_public_web,
    )
    ctx.register_tool(
        name="read_public_web",
        toolset="poc_line_agent_web_research",
        schema=schemas.READ_PUBLIC_WEB,
        handler=tools.read_public_web,
        is_async=True,
    )
    ctx.register_hook("pre_api_request", tools.capture_research_scope)
    ctx.register_hook("pre_tool_call", tools.require_research_scope)
