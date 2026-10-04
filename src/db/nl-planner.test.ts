import { describe, expect, test } from "bun:test";
import {
	planNaturalLanguageDatabaseQuery,
	type DbSchemaCatalog,
} from "./nl-planner";
import type { QueryPolicyConfig } from "./query-policy";

const catalog: DbSchemaCatalog = {
	datasource: "lms-readonly",
	tables: [
		{
			schema: "public",
			name: "users",
			description: "learner user accounts",
			columns: [
				{ name: "id", type: "uuid" },
				{ name: "email", type: "text", sensitive: true },
				{ name: "created_at", type: "timestamp" },
				{ name: "status", type: "text" },
			],
		},
		{
			schema: "reporting",
			name: "course_progress",
			description: "course completion progress",
			columns: [
				{ name: "course_id", type: "uuid" },
				{ name: "user_id", type: "uuid", sensitive: true },
				{ name: "status", type: "text" },
				{ name: "updated_at", type: "timestamp" },
			],
		},
	],
};

const policy: QueryPolicyConfig = {
	enabled: true,
	datasource: "lms-readonly",
	allowedSchemas: ["public", "reporting"],
	allowedTables: ["public.users", "reporting.course_progress"],
	maxRows: 50,
	maxBytes: 50_000,
	timeoutMs: 2_000,
};

describe("natural-language database query planner", () => {
	test("creates an approval-ready read-only plan from a question and catalog", async () => {
		const result = await planNaturalLanguageDatabaseQuery({
			question: "show learner users status and created date",
			catalog,
			policy,
			requestId: "req-1",
			requestedBy: "discord-user-1",
			now: "2026-10-04T00:00:00.000Z",
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.plan).toMatchObject({
			version: "DB_NL_PLAN_V1",
			status: "proposed",
			requestId: "req-1",
			requestedBy: "discord-user-1",
			sql: "SELECT created_at, status FROM public.users LIMIT 50",
			referencedTables: ["public.users"],
			selectedColumns: ["created_at", "status"],
			approval: {
				required: true,
			},
		});
		expect(result.plan.planDigest).toMatch(/^[0-9a-f]{64}$/);
		expect(result.plan.catalogDigest).toMatch(/^[0-9a-f]{64}$/);
		expect(result.plan.approval.operationDigest).toBe(result.plan.planDigest);
		expect(result.plan.warnings).toContain(
			"Selected table contains sensitive columns; response rows must be masked.",
		);
	});

	test("keeps the same immutable digest for identical approval inputs", async () => {
		const input = {
			question: "show learner users status",
			catalog,
			policy,
			requestId: "req-2",
			requestedBy: "discord-user-1",
			now: "2026-10-04T00:00:00.000Z",
		};
		const first = await planNaturalLanguageDatabaseQuery(input);
		const second = await planNaturalLanguageDatabaseQuery(input);

		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		if (!first.ok || !second.ok) return;
		expect(first.plan.planDigest).toBe(second.plan.planDigest);
	});

	test("changes digest when SQL proposal changes", async () => {
		const base = {
			question: "show users",
			catalog,
			policy,
			requestId: "req-3",
			requestedBy: "discord-user-1",
			now: "2026-10-04T00:00:00.000Z",
		};
		const first = await planNaturalLanguageDatabaseQuery({
			...base,
			sqlProposal: "SELECT id FROM public.users",
		});
		const second = await planNaturalLanguageDatabaseQuery({
			...base,
			sqlProposal: "SELECT status FROM public.users",
		});

		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		if (!first.ok || !second.ok) return;
		expect(first.plan.planDigest).not.toBe(second.plan.planDigest);
	});

	test("rejects unsafe upstream SQL proposals through the read-only policy", async () => {
		const result = await planNaturalLanguageDatabaseQuery({
			question: "remove user",
			catalog,
			policy,
			requestId: "req-4",
			requestedBy: "discord-user-1",
			sqlProposal: "DELETE FROM public.users",
		});

		expect(result).toMatchObject({
			ok: false,
			reason:
				"Proposed query violates policy: Only SELECT or WITH queries are allowed",
		});
	});

	test("fails closed when the question cannot map to one allowlisted table", async () => {
		const result = await planNaturalLanguageDatabaseQuery({
			question: "show payment failures",
			catalog,
			policy,
			requestId: "req-5",
			requestedBy: "discord-user-1",
		});

		expect(result).toMatchObject({
			ok: false,
			reason:
				"Could not map the question to exactly one allowlisted catalog table",
		});
	});

	test("rejects invalid catalog identifiers before planning", async () => {
		const result = await planNaturalLanguageDatabaseQuery({
			question: "show users",
			catalog: {
				datasource: "lms-readonly",
				tables: [
					{ schema: "public", name: "bad-name", columns: [{ name: "id" }] },
				],
			},
			policy,
			requestId: "req-6",
			requestedBy: "discord-user-1",
		});

		expect(result).toMatchObject({
			ok: false,
			reason: "Invalid table identifier: public.bad-name",
		});
	});
});
