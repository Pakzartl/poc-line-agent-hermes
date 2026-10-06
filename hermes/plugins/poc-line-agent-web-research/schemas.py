def _schema(name, description, properties, required):
    return {
        "name": name,
        "description": description,
        "parameters": {
            "type": "object",
            "properties": properties,
            "required": required,
            "additionalProperties": False,
        },
    }


SEARCH_PUBLIC_WEB = _schema(
    "search_public_web",
    "Search the public web in a research session. Returns bounded result metadata with URLs. Use focused queries and prefer official or primary sources.",
    {
        "query": {
            "type": "string",
            "description": "Focused public-web search query.",
            "minLength": 1,
            "maxLength": 300,
        },
        "limit": {
            "type": "integer",
            "description": "Number of results from 1 to 8.",
            "minimum": 1,
            "maximum": 8,
        },
    },
    ["query"],
)


READ_PUBLIC_WEB = _schema(
    "read_public_web",
    "Read up to three public HTTPS pages returned by search_public_web during the same research turn. Private-network and credential-bearing URLs are blocked by Hermes.",
    {
        "urls": {
            "type": "array",
            "items": {"type": "string"},
            "minItems": 1,
            "maxItems": 3,
            "description": "Public HTTPS URLs from this turn's search results.",
        },
    },
    ["urls"],
)
