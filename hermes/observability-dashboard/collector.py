#!/usr/bin/env python3
"""Collect a bounded, redacted OVH operational snapshot for the dashboard."""

import json
import os
import pwd
import re
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


OUTPUT_PATH = Path(os.environ.get(
    "OBSERVABILITY_SNAPSHOT_PATH",
    "/srv/hermes/observability/snapshot.json",
))
OBSERVABILITY_USER = os.environ.get("OBSERVABILITY_USER", "observability")
MAX_HISTORY_POINTS = 360
MAX_LOG_LINES = 120
MAX_LOG_LINE_CHARS = 1_500
CONTAINERS = (
    "poc-line-agent-hermes",
    "poc-line-agent-discord-gateway",
    "poc-line-agent-capability-adapter",
)
SYSTEMD_SERVICES = (
    "cloudflared.service",
    "poc-line-agent-deploy-executor.service",
)
SECRET_PATTERNS = (
    re.compile(r"(?i)(authorization\s*[:=]\s*(?:bearer\s+|basic\s+)?)([^\s,;]+)"),
    re.compile(r"(?i)((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|cookie)\s*[:=]\s*)([^\s,;]+)"),
    re.compile(r'(?i)("(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|cookie)"\s*:\s*")[^"]*(")'),
    re.compile(r"(?i)(/webhooks/\d+/)[A-Za-z0-9._-]+"),
)


def run(command, timeout=8):
    completed = subprocess.run(
        command,
        check=False,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    return completed.returncode, completed.stdout, completed.stderr


def redact_line(value):
    line = re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", str(value)).replace("\x00", "")
    for index, pattern in enumerate(SECRET_PATTERNS):
        if index == 2:
            line = pattern.sub(r"\1[redacted]\2", line)
        else:
            line = pattern.sub(r"\1[redacted]", line)
    return line[:MAX_LOG_LINE_CHARS]


def bounded_log_lines(value):
    return [redact_line(line) for line in value.splitlines()[-MAX_LOG_LINES:]]


def read_cpu_sample():
    values = Path("/proc/stat").read_text(encoding="utf-8").splitlines()[0].split()[1:]
    numbers = [int(value) for value in values]
    idle = numbers[3] + (numbers[4] if len(numbers) > 4 else 0)
    return sum(numbers), idle


def cpu_percent():
    total_before, idle_before = read_cpu_sample()
    time.sleep(0.15)
    total_after, idle_after = read_cpu_sample()
    total_delta = total_after - total_before
    if total_delta <= 0:
        return 0.0
    return round(100 * (1 - (idle_after - idle_before) / total_delta), 2)


def memory_metrics():
    values = {}
    for line in Path("/proc/meminfo").read_text(encoding="utf-8").splitlines():
        key, raw = line.split(":", 1)
        values[key] = int(raw.strip().split()[0]) * 1024
    total = values["MemTotal"]
    available = values["MemAvailable"]
    used = total - available
    return {
        "totalBytes": total,
        "usedBytes": used,
        "availableBytes": available,
        "usedPercent": round(used / total * 100, 2),
    }


def disk_metrics():
    usage = shutil.disk_usage("/")
    return {
        "totalBytes": usage.total,
        "usedBytes": usage.used,
        "freeBytes": usage.free,
        "usedPercent": round(usage.used / usage.total * 100, 2),
    }


def parse_percent(value):
    try:
        return float(str(value).strip().rstrip("%"))
    except (TypeError, ValueError):
        return None


def parse_int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def container_metrics(name):
    inspect_code, inspect_output, inspect_error = run(["docker", "inspect", name])
    stats_code, stats_output, stats_error = run(
        ["docker", "stats", "--no-stream", "--format", "{{json .}}", name],
        timeout=12,
    )
    result = {
        "name": name,
        "status": "unavailable",
        "health": "unknown",
        "cpuPercent": None,
        "memoryPercent": None,
        "memoryUsage": "-",
        "networkIO": "-",
        "blockIO": "-",
        "pids": None,
        "restartCount": None,
    }
    if inspect_code == 0:
        inspected = json.loads(inspect_output)[0]
        state = inspected.get("State", {})
        result.update({
            "status": state.get("Status", "unknown"),
            "health": state.get("Health", {}).get("Status", "not-configured"),
            "restartCount": inspected.get("RestartCount", 0),
        })
    else:
        result["error"] = redact_line(inspect_error or "docker inspect failed")
    if stats_code == 0 and stats_output.strip():
        stats = json.loads(stats_output.splitlines()[-1])
        result.update({
            "cpuPercent": parse_percent(stats.get("CPUPerc")),
            "memoryPercent": parse_percent(stats.get("MemPerc")),
            "memoryUsage": stats.get("MemUsage", "-"),
            "networkIO": stats.get("NetIO", "-"),
            "blockIO": stats.get("BlockIO", "-"),
            "pids": parse_int(stats.get("PIDs")),
        })
    elif "error" not in result:
        result["error"] = redact_line(stats_error or "docker stats failed")
    return result


def systemd_status(service):
    code, output, _ = run(["systemctl", "is-active", service], timeout=4)
    return output.strip() if output.strip() else ("inactive" if code else "unknown")


def cloudflared_metrics():
    selected = {
        "cloudflared_tunnel_ha_connections": "haConnections",
        "cloudflared_tunnel_total_requests": "totalRequests",
        "cloudflared_tunnel_request_errors": "requestErrors",
        "cloudflared_tunnel_concurrent_requests_per_tunnel": "concurrentRequests",
    }
    result = {value: None for value in selected.values()}
    try:
        with urllib.request.urlopen("http://127.0.0.1:20241/metrics", timeout=3) as response:
            body = response.read(1_000_000).decode("utf-8", errors="replace")
        for line in body.splitlines():
            name, separator, raw = line.partition(" ")
            key = selected.get(name)
            if key and separator:
                result[key] = float(raw)
    except Exception as exc:
        result["error"] = redact_line(exc)
    return result


def collect_logs():
    logs = {}
    for name in CONTAINERS:
        _, output, error = run(
            ["docker", "logs", "--since", "30m", "--tail", str(MAX_LOG_LINES), name],
            timeout=8,
        )
        logs[name] = bounded_log_lines("\n".join(part for part in (output, error) if part))
    for service in SYSTEMD_SERVICES:
        _, output, error = run([
            "journalctl", "--no-pager", "--output=short-iso", "--since=-30min",
            "--lines", str(MAX_LOG_LINES), "--unit", service,
        ], timeout=8)
        logs[service] = bounded_log_lines("\n".join(part for part in (output, error) if part))
    return logs


def previous_history():
    try:
        current = json.loads(OUTPUT_PATH.read_text(encoding="utf-8"))
        history = current.get("history", [])
        return history if isinstance(history, list) else []
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return []


def collect_snapshot():
    timestamp = datetime.now(timezone.utc).isoformat()
    load_1, load_5, load_15 = os.getloadavg()
    system = {
        "hostname": socket.gethostname(),
        "timestamp": timestamp,
        "uptimeSeconds": round(float(Path("/proc/uptime").read_text().split()[0])),
        "cpuPercent": cpu_percent(),
        "loadAverage": [round(load_1, 2), round(load_5, 2), round(load_15, 2)],
        "memory": memory_metrics(),
        "disk": disk_metrics(),
    }
    point = {
        "timestamp": timestamp,
        "cpuPercent": system["cpuPercent"],
        "memoryPercent": system["memory"]["usedPercent"],
        "diskPercent": system["disk"]["usedPercent"],
        "load1": system["loadAverage"][0],
    }
    return {
        "version": 1,
        "system": system,
        "containers": [container_metrics(name) for name in CONTAINERS],
        "services": {service: systemd_status(service) for service in SYSTEMD_SERVICES},
        "cloudflared": cloudflared_metrics(),
        "history": (previous_history() + [point])[-MAX_HISTORY_POINTS:],
        "logs": collect_logs(),
    }


def write_snapshot(snapshot):
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    user = pwd.getpwnam(OBSERVABILITY_USER)
    payload = json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")) + "\n"
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=OUTPUT_PATH.parent, prefix="snapshot-", delete=False,
    ) as handle:
        handle.write(payload)
        temporary = Path(handle.name)
    os.chown(temporary, 0, user.pw_gid)
    os.chmod(temporary, 0o640)
    os.replace(temporary, OUTPUT_PATH)


if __name__ == "__main__":
    write_snapshot(collect_snapshot())
