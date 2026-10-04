import { spawn } from "node:child_process";
import {
	renderSqlLiteral,
	type QueryParameter,
	type ValidatedQuery,
} from "./policy";
import type { DbDatasourceConfig } from "./config";

export type DbExecutionResult = {
	rows: readonly Record<string, unknown>[];
	truncated?: boolean;
};

export type DbExecutor = (input: {
	query: ValidatedQuery;
	datasource: DbDatasourceConfig;
	env: Readonly<Record<string, string | undefined>>;
}) => Promise<DbExecutionResult>;

export const executeWithPsql: DbExecutor = async ({
	query,
	datasource,
	env,
}) => {
	const connectionString = env[datasource.connectionStringEnv]?.trim();
	if (!connectionString) {
		throw new Error("datasource connection string is not configured");
	}
	const sql = bindParameters(query.sql, query.params);
	const boundedSql = `
BEGIN READ ONLY;
SET LOCAL statement_timeout = ${Math.max(1, query.limits.timeoutMs)};
SET LOCAL idle_in_transaction_session_timeout = ${Math.max(1, query.limits.timeoutMs)};
SET LOCAL default_transaction_read_only = on;
COPY (
  SELECT COALESCE(json_agg(row_to_json(_javis_row)), '[]'::json)
  FROM (
    ${sql}
    LIMIT ${query.limits.maxRows + 1}
  ) AS _javis_row
) TO STDOUT;
ROLLBACK;
`;
	const stdout = await runPsql(
		connectionString,
		boundedSql,
		query.limits.maxBytes,
	);
	const parsed = JSON.parse(stdout.trim() || "[]") as unknown;
	if (!Array.isArray(parsed)) {
		throw new Error("database returned non-array JSON");
	}
	const rows = parsed.filter(isRow).slice(0, query.limits.maxRows);
	const encodedBytes = new TextEncoder().encode(
		JSON.stringify(rows),
	).byteLength;
	if (encodedBytes > query.limits.maxBytes) {
		throw new Error("database response exceeds byte limit");
	}
	return { rows, truncated: parsed.length > rows.length };
};

export function bindParameters(
	sql: string,
	params: readonly QueryParameter[],
): string {
	return sql.replace(/\$(\d+)\b/g, (_match, rawIndex: string) => {
		const index = Number(rawIndex) - 1;
		const value = params[index];
		if (value === undefined) {
			throw new Error("missing SQL parameter");
		}
		return renderSqlLiteral(value);
	});
}

function runPsql(
	connectionString: string,
	sql: string,
	maxBytes: number,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			"psql",
			[
				"--no-psqlrc",
				"-X",
				"-v",
				"ON_ERROR_STOP=1",
				"--no-align",
				"--tuples-only",
			],
			{
				stdio: ["pipe", "pipe", "pipe"],
				env: { ...process.env, PGDATABASE: connectionString },
			},
		);
		let stdout = "";
		let stderr = "";
		let stdoutBytes = 0;
		child.stdout.on("data", (chunk: Buffer) => {
			stdoutBytes += chunk.byteLength;
			if (stdoutBytes > maxBytes + 8_192) {
				child.kill("SIGTERM");
				reject(new Error("database response exceeded adapter byte guard"));
				return;
			}
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0) {
				reject(new Error(sanitizePsqlError(stderr)));
				return;
			}
			resolve(stdout);
		});
		child.stdin.end(sql);
	});
}

function sanitizePsqlError(stderr: string): string {
	return (
		stderr
			.replace(/postgres(?:ql)?:\/\/\S+/gi, "postgres://[redacted]")
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.slice(0, 3)
			.join("; ") || "psql failed"
	);
}

function isRow(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
