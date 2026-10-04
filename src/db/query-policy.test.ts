import { describe, expect, test } from "bun:test";
import {
	maskQueryRows,
	planReadOnlyQuery,
	redactQueryAudit,
	type QueryPolicyConfig,
} from "./query-policy";

const policy: QueryPolicyConfig = {
	enabled: true,
	datasource: "lms-readonly",
	allowedSchemas: ["public", "lms"],
	allowedTables: ["public.users", "courses", "lms.enrollments"],
	maxRows: 100,
	maxBytes: 50_000,
	timeoutMs: 2_000,
};

describe("read-only query policy", () => {
	test("is disabled by default when no datasource is configured", () => {
		const result = planReadOnlyQuery({
			sql: "select * from public.users",
			policy: { ...policy, enabled: false },
		});

		expect(result).toEqual({
			ok: false,
			reason: "Database queries are disabled until a datasource is configured",
		});
	});

	test("accepts a bounded SELECT plan with contiguous parameters", () => {
		const result = planReadOnlyQuery({
			sql: " SELECT id, email FROM public.users WHERE id = $1 ",
			params: [123],
			policy,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.plan).toMatchObject({
			datasource: "lms-readonly",
			sql: "SELECT id, email FROM public.users WHERE id = $1",
			maxRows: 100,
			maxBytes: 50_000,
			timeoutMs: 2_000,
		});
		expect(result.plan.audit.referencedTables).toEqual(["public.users"]);
		expect(result.plan.fingerprint).toMatch(/^q_[0-9a-f]{8}$/);
	});

	test("accepts WITH queries that read allowlisted tables", () => {
		const result = planReadOnlyQuery({
			sql: "with recent as (select id from lms.enrollments) select * from recent join courses on courses.id = recent.id",
			policy,
		});

		expect(result.ok).toBe(true);
	});

	test("rejects mutation, DDL, transaction, COPY, comments, and multi statements", () => {
		for (const sql of [
			"update public.users set email = $1",
			"drop table public.users",
			"begin; select * from public.users",
			"copy public.users to stdout",
			"select * from public.users -- hidden",
			"select * from public.users; select * from courses",
			"select * into temp_users from public.users",
			"select pg_sleep(10) from public.users",
		]) {
			const result = planReadOnlyQuery({ sql, policy });
			expect(result.ok, sql).toBe(false);
		}
	});

	test("rejects unallowlisted schemas and tables", () => {
		expect(
			planReadOnlyQuery({ sql: "select * from private.users", policy }),
		).toMatchObject({
			ok: false,
			reason: "Schema is not allowlisted: private",
		});
		expect(
			planReadOnlyQuery({ sql: "select * from public.payments", policy }),
		).toMatchObject({
			ok: false,
			reason: "Table is not allowlisted: public.payments",
		});
	});

	test("rejects relation syntax the allowlist extractor cannot prove", () => {
		expect(
			planReadOnlyQuery({
				sql: "select secrets.password from public.users users, private.secrets secrets",
				policy,
			}),
		).toMatchObject({ ok: false, reason: "Comma joins are not supported" });
		expect(
			planReadOnlyQuery({
				sql: 'select * from public.users join "private"."secrets" on true',
				policy,
			}),
		).toMatchObject({
			ok: false,
			reason: "Quoted SQL identifiers are not supported",
		});
		expect(
			planReadOnlyQuery({
				sql: "select id, email from public.users where id in (1, 2)",
				policy,
			}).ok,
		).toBe(true);
	});

	test("validates query parameters deterministically", () => {
		expect(
			planReadOnlyQuery({
				sql: "select * from public.users where id = $2",
				params: [1, 2],
				policy,
			}),
		).toMatchObject({
			ok: false,
			reason: "Query parameters must be contiguous",
		});
		expect(
			planReadOnlyQuery({
				sql: "select * from public.users where id = $1",
				params: [],
				policy,
			}),
		).toMatchObject({
			ok: false,
			reason: "Parameter count does not match SQL placeholders",
		});
		expect(
			planReadOnlyQuery({
				sql: "select * from public.users where email = $1",
				params: ["\ud800"],
				policy,
			}),
		).toMatchObject({
			ok: false,
			reason: "Query parameter contains an unsupported value",
		});
	});

	test("rejects invalid Unicode before SQL parsing", () => {
		expect(
			planReadOnlyQuery({
				sql: "select '\ud800' from public.users",
				policy,
			}),
		).toEqual({ ok: false, reason: "SQL contains invalid Unicode" });
	});

	test("masks PII and redacts audit identifiers", () => {
		expect(
			maskQueryRows([
				{ id: 1, email: "a@example.com", access_token: "secret", title: "ok" },
			]),
		).toEqual([
			{ id: 1, email: "[masked]", access_token: "[masked]", title: "ok" },
		]);

		const result = planReadOnlyQuery({
			sql: "select * from public.users",
			policy,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(redactQueryAudit(result.plan.audit).referencedTables).toEqual([
			"pu....us...",
		]);
	});
});
