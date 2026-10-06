import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const verifier = new URL("../verify-readonly-role.sh", import.meta.url)
	.pathname;

describe("read-only database role verifier", () => {
	test("passes only when read-only default is on and the write probe fails", async () => {
		const fixture = await fakePsql();
		try {
			const result = await runVerifier(fixture, { FAKE_WRITE_STATUS: "1" });
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("read-only role verified");
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	});

	test("fails when the database role permits the write probe", async () => {
		const fixture = await fakePsql();
		try {
			const result = await runVerifier(fixture, { FAKE_WRITE_STATUS: "0" });
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("DELETE statement was permitted");
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	});
});

async function fakePsql(): Promise<{ root: string; path: string }> {
	const root = await mkdtemp(join(tmpdir(), "javis-readonly-role-"));
	const path = join(root, "psql");
	await writeFile(
		path,
		`#!/bin/sh
case "$*" in
  *default_transaction_read_only*) printf 'on\\n'; exit 0 ;;
  *DELETE*) exit "\${FAKE_WRITE_STATUS:-1}" ;;
esac
exit 2
`,
	);
	await chmod(path, 0o700);
	return { root, path };
}

async function runVerifier(
	fixture: { path: string },
	extraEnv: Record<string, string>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const process = Bun.spawn(["/bin/sh", verifier], {
		env: {
			...Bun.env,
			...extraEnv,
			PSQL_BIN: fixture.path,
			DB_READONLY_CONNECTION_ENV: "FIXTURE_DATABASE_URL",
			DB_READONLY_PROBE_TABLE: "public.users",
			FIXTURE_DATABASE_URL: "postgres://fixture.invalid/read_only",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
		process.exited,
	]);
	return { exitCode, stdout, stderr };
}
