import {
	maskQueryRows,
	planReadOnlyQuery,
	type QueryAuditSummary,
	type QueryParameter,
	type QueryPolicyConfig,
} from "./query-policy";

type FetchLike = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

export type DatabaseReadResult = {
	columns: string[];
	rows: Record<string, unknown>[];
	rowCount: number;
	truncated: boolean;
	audit: QueryAuditSummary;
};

export type DatabaseReadClient = {
	query(input: {
		sql: string;
		params?: readonly QueryParameter[];
		requestId: string;
		requestedBy: string;
	}): Promise<DatabaseReadResult>;
};

export function createDatabaseReadClient(input: {
	endpoint: string;
	token: string;
	policy: QueryPolicyConfig;
	fetch?: FetchLike;
}): DatabaseReadClient {
	return {
		async query(request) {
			if (!input.endpoint.trim() || !input.token.trim()) {
				throw new Error("Read-only database adapter is not configured");
			}
			const planResult = planReadOnlyQuery({
				sql: request.sql,
				params: request.params,
				policy: input.policy,
			});
			if (!planResult.ok) {
				throw new Error(`Database request rejected: ${planResult.reason}`);
			}
			const endpoint = new URL(input.endpoint);
			if (endpoint.protocol !== "https:") {
				throw new Error("Database adapter endpoint must use HTTPS");
			}
			const response = await (input.fetch ?? fetch)(endpoint, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${input.token}`,
					"Content-Type": "application/json",
					"Idempotency-Key": request.requestId,
				},
				body: JSON.stringify({
					version: "DB_READ_REQUEST_V1",
					datasource: planResult.plan.datasource,
					sql: planResult.plan.sql,
					params: planResult.plan.params,
					limits: {
						maxRows: planResult.plan.maxRows,
						maxBytes: planResult.plan.maxBytes,
						timeoutMs: planResult.plan.timeoutMs,
					},
					requestId: request.requestId,
					requestedBy: request.requestedBy,
					fingerprint: planResult.plan.fingerprint,
				}),
			});
			if (!response.ok) {
				throw new Error(`Database adapter failed (${response.status})`);
			}
			const raw = (await response.json()) as Record<string, unknown>;
			if (!Array.isArray(raw.rows)) {
				throw new Error("Database adapter returned an invalid response");
			}
			const rows = raw.rows.filter(isRow).slice(0, planResult.plan.maxRows);
			const maskedRows = maskQueryRows(rows, planResult.plan.maskColumns);
			const encodedBytes = new TextEncoder().encode(
				JSON.stringify(maskedRows),
			).byteLength;
			if (encodedBytes > planResult.plan.maxBytes) {
				throw new Error("Database response exceeds the configured byte limit");
			}
			return {
				columns: [...new Set(maskedRows.flatMap((row) => Object.keys(row)))],
				rows: maskedRows,
				rowCount: maskedRows.length,
				truncated:
					raw.rows.length > maskedRows.length || raw.truncated === true,
				audit: planResult.plan.audit,
			};
		},
	};
}

function isRow(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
