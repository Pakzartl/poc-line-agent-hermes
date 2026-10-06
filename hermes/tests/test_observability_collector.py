import importlib.util
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
COLLECTOR = ROOT / "hermes" / "observability-dashboard" / "collector.py"


def load_collector():
    spec = importlib.util.spec_from_file_location("observability_collector", COLLECTOR)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


collector = load_collector()


def test_redacts_operational_secrets_and_webhook_tokens():
    value = (
        'Authorization: Bearer abc123 token=secret-value '
        '"password":"hunter2" /webhooks/123456/discord-token'
    )

    redacted = collector.redact_line(value)

    assert "abc123" not in redacted
    assert "secret-value" not in redacted
    assert "hunter2" not in redacted
    assert "discord-token" not in redacted
    assert redacted.count("[redacted]") == 4


def test_bounds_log_lines_and_line_length():
    lines = [f"line-{index}-" + "x" * 2_000 for index in range(150)]

    bounded = collector.bounded_log_lines("\n".join(lines))

    assert len(bounded) == collector.MAX_LOG_LINES
    assert bounded[0].startswith("line-30-")
    assert all(len(line) <= collector.MAX_LOG_LINE_CHARS for line in bounded)


def test_percent_and_integer_parsers_fail_closed():
    assert collector.parse_percent("12.34%") == 12.34
    assert collector.parse_percent("invalid") is None
    assert collector.parse_int("42") == 42
    assert collector.parse_int(None) is None
