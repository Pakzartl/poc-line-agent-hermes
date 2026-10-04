import { describe, expect, test } from "bun:test";
import type { DbAdapterConfig } from "./config";
import { bindParameters } from "./executor";
import { fingerprintSql } from "./policy";
import { createDbAdapterHandler } from "./server";

const config: DbAdapterConfig = {
	port: 8789,
	token: "b".repeat(32),
	datasources: [
		{
			alias: "lms-readonly",
			connectionStringEnv: "LMS_READONLY_URL",
			allowedSchemas: ["public"],
			allowedTables: ["public.users"],
		},
	],
	limits: { maxRows: 10, maxBytes: 10_000, timeoutMs: 2_000 },
};

const auth = { Authorization: `Bearer ${"b".repeat(32)}` };

function validBody(overrides: Record<string, unknown> = {}) {
	const sql =
		typeof overrides.sql === "string"
			? overrides.sql
			: "SELECT id FROM public.users WHERE id = $1";
	return {
		version: "DB_READ_REQUEST_V1",
		datasource: "lms-readonly",
		sql,
		params: [1],
		limits: { maxRows: 2, maxBytes: 1_000, timeoutMs: 500 },
		requestId: "discord:job-1",
		requestedBy: "discord-user-1",
		fingerprint: fingerprintSql(sql),
		...overrides,
	};
}

describe("db adapter", () => {
	test("serves health without authentication", async () => {
		const handler = createDbAdapterHandler({
			config,
			execute: async () => ({ rows: [] }),
		});
		const response = await handler(new Request("http://db.test/health"));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			ok: true,
			service: "db-adapter",
		});
	});

	test("requires bearer auth", async () => {
		const handler = createDbAdapterHandler({
			config,
			execute: async () => ({ rows: [] }),
		});
		const response = await handler(
			new Request("http://db.test/db/query", {
				method: "POST",
				body: JSON.stringify(validBody()),
			}),
		);
		expect(response.status).toBe(401);
	});

	test("executes a validated bounded read and truncates rows", async () => {
		const calls: string[] = [];
		const handler = createDbAdapterHandler({
			config,
			execute: async ({ query }) => {
				calls.push(query.sql);
				return { rows: [{ id: 1 }, { id: 2 }, { id: 3 }] };
			},
		});
		const response = await handler(
			new Request("http://db.test/db/query", {
				method: "POST",
				headers: { ...auth, "Content-Type": "application/json" },
				body: JSON.stringify(validBody()),
			}),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			datasource: "lms-readonly",
			rows: [{ id: 1 }, { id: 2 }],
			columns: ["id"],
			rowCount: 2,
			truncated: true,
			durationMs: expect.any(Number),
		});
		expect(calls).toEqual(["SELECT id FROM public.users WHERE id = $1"]);
	});

	test("enforces datasource schema and table allowlists inside the adapter", async () => {
		const handler = createDbAdapterHandler({
			config,
			execute: async () => ({ rows: [] }),
		});
		for (const sql of [
			"SELECT id FROM private.users",
			"SELECT id FROM public.payments",
			"SELECT 1",
		]) {
			const response = await handler(
				new Request("http://db.test/db/query", {
					method: "POST",
					headers: auth,
					body: JSON.stringify(
						validBody({ sql, params: [], fingerprint: fingerprintSql(sql) }),
					),
				}),
			);
			expect(response.status).toBe(400);
		}
	});

	test("rejects comma joins and quoted identifiers before execution", async () => {
		let executeCalls = 0;
		const handler = createDbAdapterHandler({
			config,
			execute: async () => {
				executeCalls += 1;
				return { rows: [] };
			},
		});
		for (const sql of [
			"SELECT secrets.password FROM public.users users, private.secrets secrets",
			'SELECT * FROM public.users JOIN "private"."secrets" ON true',
		]) {
			const response = await handler(
				new Request("http://db.test/db/query", {
					method: "POST",
					headers: auth,
					body: JSON.stringify(
						validBody({ sql, params: [], fingerprint: fingerprintSql(sql) }),
					),
				}),
			);
			expect(response.status).toBe(400);
		}
		expect(executeCalls).toBe(0);
	});

	test("rejects writes, comments, multi statement input, and unsafe functions", async () => {
		const handler = createDbAdapterHandler({
			config,
			execute: async () => ({ rows: [] }),
		});
		for (const sql of [
			"UPDATE public.users SET name = 'x'",
			"SELECT * FROM public.users; SELECT * FROM public.users",
			"SELECT * FROM public.users -- comment",
			"SELECT pg_sleep(10) FROM public.users",
		]) {
			const response = await handler(
				new Request("http://db.test/db/query", {
					method: "POST",
					headers: auth,
					body: JSON.stringify(
						validBody({ sql, params: [], fingerprint: fingerprintSql(sql) }),
					),
				}),
			);
			expect(response.status).toBe(400);
		}
	});

	test("rejects oversized payloads, unconfigured datasources, limit escalation, and fingerprint mismatch", async () => {
		const handler = createDbAdapterHandler({
			config,
			execute: async () => ({ rows: [] }),
		});
		const oversized = await handler(
			new Request("http://db.test/db/query", {
				method: "POST",
				headers: { ...auth, "Content-Length": "32769" },
				body: "{}",
			}),
		);
		expect(oversized.status).toBe(413);

		for (const overrides of [
			{ datasource: "prod-writer" },
			{ limits: { maxRows: 11, maxBytes: 1_000, timeoutMs: 500 } },
			{ fingerprint: "q_wrong" },
		]) {
			const response = await handler(
				new Request("http://db.test/db/query", {
					method: "POST",
					headers: auth,
					body: JSON.stringify(validBody(overrides)),
				}),
			);
			expect([400, 404, 409]).toContain(response.status);
		}
	});

	test("quotes parameters for the psql executor path", () => {
		expect(
			bindParameters("SELECT * FROM public.users WHERE name = $1 AND ok = $2", [
				"O'Reilly",
				true,
			]),
		).toBe("SELECT * FROM public.users WHERE name = 'O''Reilly' AND ok = TRUE");
		expect(
			bindParameters("SELECT * FROM public.users WHERE id = ANY($1)", [
				[1, 2, 3],
			]),
		).toBe("SELECT * FROM public.users WHERE id = ANY(ARRAY[1,2,3])");
	});
});
