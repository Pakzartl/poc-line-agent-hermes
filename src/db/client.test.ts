import { describe, expect, test } from "bun:test";
import { createDatabaseReadClient } from "./client";

const policy = {
	enabled: true,
	datasource: "lms-readonly",
	allowedSchemas: ["public"],
	allowedTables: ["public.users"],
	maxRows: 2,
	maxBytes: 10_000,
	timeoutMs: 2_000,
} as const;

describe("database read client", () => {
	test("sends a bounded plan and masks sensitive columns", async () => {
		let captured: Record<string, unknown> | undefined;
		const client = createDatabaseReadClient({
			endpoint: "https://db.example.com/v1/query",
			token: "secret",
			policy,
			fetch: async (_url, init) => {
				captured = JSON.parse(String(init?.body));
				return Response.json({
					rows: [
						{ id: 1, email: "person@example.com" },
						{ id: 2, email: "other@example.com" },
						{ id: 3, email: "third@example.com" },
					],
				});
			},
		});
		const result = await client.query({
			sql: "SELECT id, email FROM public.users WHERE id = $1",
			params: [1],
			requestId: "job-1",
			requestedBy: "discord-user",
		});
		expect(captured?.version).toBe("DB_READ_REQUEST_V1");
		expect(captured).not.toHaveProperty("token");
		expect(result.rows).toEqual([
			{ id: 1, email: "[masked]" },
			{ id: 2, email: "[masked]" },
		]);
		expect(result.truncated).toBe(true);
	});

	test("does not call the adapter for unsafe SQL", async () => {
		let called = false;
		const client = createDatabaseReadClient({
			endpoint: "https://db.example.com/v1/query",
			token: "secret",
			policy,
			fetch: async () => {
				called = true;
				return Response.json({ rows: [] });
			},
		});
		await expect(
			client.query({
				sql: "DELETE FROM public.users",
				requestId: "job-2",
				requestedBy: "discord-user",
			}),
		).rejects.toThrow("rejected");
		expect(called).toBe(false);
	});
});
