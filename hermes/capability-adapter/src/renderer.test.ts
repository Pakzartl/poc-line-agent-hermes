import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildChromiumCommand } from "./renderer";

describe("capability renderer isolation", () => {
	test("pins the allowlisted host and makes redirect hosts unresolvable", () => {
		const command = buildChromiumCommand({
			url: new URL("https://artifact.example/health"),
			pinnedAddress: "203.0.113.10",
			output: "/tmp/output.png",
			profile: "/tmp/profile",
			chromiumBin: "/usr/bin/chromium-headless-shell",
		});

		expect(command).toContain(
			"--host-resolver-rules=MAP artifact.example 203.0.113.10, MAP * ~NOTFOUND",
		);
		expect(command).toContain("--user-data-dir=/tmp/profile");
		expect(command).toContain("--disk-cache-dir=/tmp/profile/cache");
		expect(command.at(-1)).toBe("https://artifact.example/health");
	});

	test("keeps the browser in an explicit non-root locked-down sidecar", async () => {
		const here = dirname(fileURLToPath(import.meta.url));
		const dockerfile = await readFile(join(here, "..", "Dockerfile"), "utf8");
		const compose = await readFile(
			join(here, "..", "..", "compose.yaml"),
			"utf8",
		);

		expect(dockerfile).toContain("USER bun");
		expect(compose).toContain('user: "1000:1000"');
		expect(compose).toContain("read_only: true");
		expect(compose).toContain("no-new-privileges:true");
		expect(compose).toContain("cap_drop:\n      - ALL");
		expect(compose).toContain("pids_limit: 128");
	});
});
