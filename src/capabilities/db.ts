export type DatabaseIntent =
	| { ok: true; sql: string; reason: string }
	| { ok: false; reason: string };

const forbiddenSql =
	/\b(alter|analyze|attach|begin|call|comment|commit|copy|create|delete|drop|execute|explain\s+analyze|grant|insert|listen|lock|merge|notify|reindex|reset|revoke|rollback|select\s+.*\binto\b|set|truncate|update|vacuum)\b/i;
const readOnlySql = /^\s*(select|with)\b/i;

export function validateReadOnlySql(input: string): DatabaseIntent {
	const sql = input.trim();
	if (!sql) {
		return { ok: false, reason: "SQL is required." };
	}
	if (sql.length > 4_000) {
		return { ok: false, reason: "SQL is too long. Limit is 4,000 characters." };
	}
	if (!readOnlySql.test(sql)) {
		return {
			ok: false,
			reason: "Only SELECT or WITH read-only queries are allowed.",
		};
	}
	if (forbiddenSql.test(sql)) {
		return {
			ok: false,
			reason:
				"The query contains a statement or keyword that is not allowed in read-only mode.",
		};
	}
	return { ok: true, sql, reason: "Read-only query accepted." };
}
