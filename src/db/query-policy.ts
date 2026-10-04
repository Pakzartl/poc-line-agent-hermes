export type QueryPolicyConfig = {
	enabled: boolean;
	datasource: string;
	allowedSchemas: readonly string[];
	allowedTables: readonly string[];
	maxRows: number;
	maxBytes: number;
	timeoutMs: number;
	maskColumns?: readonly string[];
};

export type QueryParameter =
	| string
	| number
	| boolean
	| null
	| readonly (string | number | boolean | null)[];

export type QueryExecutionPlan = {
	datasource: string;
	sql: string;
	params: readonly QueryParameter[];
	allowedSchemas: readonly string[];
	allowedTables: readonly string[];
	maxRows: number;
	maxBytes: number;
	timeoutMs: number;
	fingerprint: string;
	audit: QueryAuditSummary;
	maskColumns: readonly string[];
};

export type QueryAuditSummary = {
	datasource: string;
	fingerprint: string;
	statementKind: "select" | "with";
	referencedTables: readonly string[];
	parameterCount: number;
	limits: {
		maxRows: number;
		maxBytes: number;
		timeoutMs: number;
	};
};

export type QueryPolicyResult =
	| { ok: true; plan: QueryExecutionPlan }
	| { ok: false; reason: string };

const mutationPattern =
	/\b(insert|update|delete|merge|upsert|alter|create|drop|truncate|grant|revoke|vacuum|analyze|refresh|reindex|listen|notify|call|do|execute|prepare|deallocate|copy)\b/i;
const transactionPattern =
	/\b(begin|commit|rollback|savepoint|release\s+savepoint|set\s+transaction|lock)\b/i;
const unsafeFunctionPattern =
	/\b(pg_sleep|pg_read_file|pg_ls_dir|pg_stat_file|dblink|lo_import|lo_export|copy_to|copy_from)\s*\(/i;
const selectIntoPattern = /\bselect\b[\s\S]*\binto\b/i;
const identifierPattern = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const placeholderPattern = /\$(\d+)\b/g;

export function planReadOnlyQuery(input: {
	sql: string;
	params?: readonly QueryParameter[];
	policy: QueryPolicyConfig;
}): QueryPolicyResult {
	const params = input.params ?? [];
	const disabled = validatePolicy(input.policy);
	if (disabled) {
		return { ok: false, reason: disabled };
	}
	if (containsInvalidUnicode(input.sql)) {
		return { ok: false, reason: "SQL contains invalid Unicode" };
	}

	const sql = normalizeSql(input.sql);
	if (!sql) {
		return { ok: false, reason: "SQL is required" };
	}
	if (sql.length > 20_000) {
		return { ok: false, reason: "SQL exceeds the maximum length" };
	}
	if (hasSqlComment(sql)) {
		return { ok: false, reason: "SQL comments are not allowed" };
	}
	if (hasMultipleStatements(sql)) {
		return { ok: false, reason: "Only one SQL statement is allowed" };
	}
	if (!/^(select|with)\b/i.test(sql)) {
		return { ok: false, reason: "Only SELECT or WITH queries are allowed" };
	}
	if (mutationPattern.test(sql) || transactionPattern.test(sql)) {
		return { ok: false, reason: "SQL contains a blocked operation" };
	}
	if (selectIntoPattern.test(sql)) {
		return { ok: false, reason: "SELECT INTO is not allowed" };
	}
	if (unsafeFunctionPattern.test(sql)) {
		return { ok: false, reason: "SQL contains a blocked function" };
	}
	const relationSyntaxError = validateSupportedRelationSyntax(sql);
	if (relationSyntaxError) {
		return { ok: false, reason: relationSyntaxError };
	}

	const paramError = validateParameters(sql, params);
	if (paramError) {
		return { ok: false, reason: paramError };
	}

	const references = referencedTables(sql);
	if (references.length === 0) {
		return { ok: false, reason: "Query must reference an allowed table" };
	}
	const allowError = validateTableReferences(references, input.policy);
	if (allowError) {
		return { ok: false, reason: allowError };
	}

	const fingerprint = fingerprintSql(sql);
	const audit: QueryAuditSummary = {
		datasource: input.policy.datasource,
		fingerprint,
		statementKind: sql.toLowerCase().startsWith("with") ? "with" : "select",
		referencedTables: references.map((ref) => ref.display),
		parameterCount: params.length,
		limits: {
			maxRows: input.policy.maxRows,
			maxBytes: input.policy.maxBytes,
			timeoutMs: input.policy.timeoutMs,
		},
	};

	return {
		ok: true,
		plan: {
			datasource: input.policy.datasource,
			sql,
			params,
			allowedSchemas: input.policy.allowedSchemas,
			allowedTables: input.policy.allowedTables,
			maxRows: input.policy.maxRows,
			maxBytes: input.policy.maxBytes,
			timeoutMs: input.policy.timeoutMs,
			fingerprint,
			audit,
			maskColumns: input.policy.maskColumns ?? defaultMaskColumns,
		},
	};
}

function validateSupportedRelationSyntax(sql: string): string | undefined {
	if (sql.includes('"')) {
		return "Quoted SQL identifiers are not supported";
	}
	const fromClauseAtDepth = new Map<number, boolean>();
	let depth = 0;
	let index = 0;
	while (index < sql.length) {
		const char = sql[index];
		if (char === "'") {
			index += 1;
			while (index < sql.length) {
				if (sql[index] !== "'") {
					index += 1;
					continue;
				}
				if (sql[index + 1] === "'") {
					index += 2;
					continue;
				}
				index += 1;
				break;
			}
			continue;
		}
		if (char === "(") {
			depth += 1;
			index += 1;
			continue;
		}
		if (char === ")") {
			fromClauseAtDepth.delete(depth);
			depth = Math.max(0, depth - 1);
			index += 1;
			continue;
		}
		if (char === "," && fromClauseAtDepth.get(depth)) {
			return "Comma joins are not supported";
		}
		if (/[A-Za-z_]/.test(char ?? "")) {
			const start = index;
			index += 1;
			while (/[A-Za-z0-9_$]/.test(sql[index] ?? "")) index += 1;
			const word = sql.slice(start, index).toLowerCase();
			if (word === "from") {
				fromClauseAtDepth.set(depth, true);
			} else if (relationClauseBoundaries.has(word)) {
				fromClauseAtDepth.set(depth, false);
			}
			continue;
		}
		index += 1;
	}
	return undefined;
}

const relationClauseBoundaries = new Set([
	"where",
	"group",
	"order",
	"having",
	"limit",
	"offset",
	"union",
	"intersect",
	"except",
	"window",
	"fetch",
	"for",
]);

export function maskQueryRows(
	rows: readonly Record<string, unknown>[],
	maskColumns: readonly string[] = defaultMaskColumns,
): Record<string, unknown>[] {
	const masked = new Set(maskColumns.map((column) => column.toLowerCase()));
	return rows.map((row) => {
		const output: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(row)) {
			output[key] = shouldMaskColumn(key, masked) ? maskValue(value) : value;
		}
		return output;
	});
}

export function redactQueryAudit(audit: QueryAuditSummary): QueryAuditSummary {
	return {
		...audit,
		referencedTables: audit.referencedTables.map(redactIdentifier),
	};
}

function validatePolicy(policy: QueryPolicyConfig): string | undefined {
	if (!policy.enabled) {
		return "Database queries are disabled until a datasource is configured";
	}
	if (!policy.datasource.trim()) {
		return "Datasource alias is required";
	}
	if (policy.allowedSchemas.length === 0 || policy.allowedTables.length === 0) {
		return "Schema and table allowlists are required";
	}
	if (
		![policy.maxRows, policy.maxBytes, policy.timeoutMs].every(isPositiveInt)
	) {
		return "Query limits must be positive integers";
	}
	if (policy.maxRows > 1_000 || policy.maxBytes > 1_000_000) {
		return "Query limits exceed the safety ceiling";
	}
	if (policy.timeoutMs > 10_000) {
		return "Query timeout exceeds the safety ceiling";
	}
	return undefined;
}

function normalizeSql(sql: string): string {
	return sql.replace(/\s+/g, " ").trim().replace(/;+$/, "");
}

function hasSqlComment(sql: string): boolean {
	return /--|\/\*|\*\//.test(sql);
}

function hasMultipleStatements(sql: string): boolean {
	const withoutTrailing = sql.trim().replace(/;+$/, "");
	return withoutTrailing.includes(";");
}

function validateParameters(
	sql: string,
	params: readonly QueryParameter[],
): string | undefined {
	if (params.length > 100) {
		return "Too many query parameters";
	}
	const seen = new Set<number>();
	for (const match of sql.matchAll(placeholderPattern)) {
		seen.add(Number(match[1]));
	}
	if (seen.size > 0) {
		const max = Math.max(...seen);
		for (let index = 1; index <= max; index += 1) {
			if (!seen.has(index)) {
				return "Query parameters must be contiguous";
			}
		}
		if (max !== params.length) {
			return "Parameter count does not match SQL placeholders";
		}
	} else if (params.length > 0) {
		return "Parameters were provided but SQL has no placeholders";
	}
	for (const param of params) {
		if (!isSafeParameter(param)) {
			return "Query parameter contains an unsupported value";
		}
	}
	return undefined;
}

function isSafeParameter(value: QueryParameter): boolean {
	if (isQueryParameterArray(value)) {
		return value.length <= 100 && value.every(isSafeScalar);
	}
	return isSafeScalar(value);
}

function isQueryParameterArray(
	value: QueryParameter,
): value is readonly (string | number | boolean | null)[] {
	return Array.isArray(value);
}

function isSafeScalar(value: string | number | boolean | null): boolean {
	if (value === null || typeof value === "boolean") {
		return true;
	}
	if (typeof value === "number") {
		return Number.isFinite(value);
	}
	return (
		value.length <= 4_000 &&
		!/[\u0000-\u001f]/.test(value) &&
		!containsInvalidUnicode(value)
	);
}

function containsInvalidUnicode(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code === 0xfffd) return true;
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) {
				return true;
			}
			index += 1;
			continue;
		}
		if (code >= 0xdc00 && code <= 0xdfff) return true;
	}
	return false;
}

type TableReference = {
	schema?: string;
	table: string;
	display: string;
};

function referencedTables(sql: string): TableReference[] {
	const references: TableReference[] = [];
	const cteAliases = commonTableExpressionAliases(sql);
	const pattern = /\b(from|join)\s+([a-zA-Z_][\w]*)(?:\.([a-zA-Z_][\w]*))?/gi;
	for (const match of sql.matchAll(pattern)) {
		const first = match[2] ?? "";
		const second = match[3];
		if (second) {
			references.push({
				schema: first,
				table: second,
				display: `${first}.${second}`,
			});
		} else if (!cteAliases.has(first.toLowerCase())) {
			references.push({ table: first, display: first });
		}
	}
	return dedupeReferences(references);
}

function commonTableExpressionAliases(sql: string): ReadonlySet<string> {
	const aliases = new Set<string>();
	if (!/^with\b/i.test(sql)) {
		return aliases;
	}
	const pattern = /(?:with|,)\s+([a-zA-Z_][\w]*)\s+as\s*\(/gi;
	for (const match of sql.matchAll(pattern)) {
		const alias = match[1];
		if (alias) {
			aliases.add(alias.toLowerCase());
		}
	}
	return aliases;
}

function dedupeReferences(
	references: readonly TableReference[],
): TableReference[] {
	const seen = new Set<string>();
	const output: TableReference[] = [];
	for (const reference of references) {
		const key = reference.display.toLowerCase();
		if (!seen.has(key)) {
			seen.add(key);
			output.push(reference);
		}
	}
	return output;
}

function validateTableReferences(
	references: readonly TableReference[],
	policy: QueryPolicyConfig,
): string | undefined {
	const schemas = new Set(
		policy.allowedSchemas.map((item) => item.toLowerCase()),
	);
	const tables = new Set(
		policy.allowedTables.map((item) => item.toLowerCase()),
	);
	for (const reference of references) {
		if (
			reference.schema &&
			(!identifierPattern.test(reference.schema) ||
				!schemas.has(reference.schema.toLowerCase()))
		) {
			return `Schema is not allowlisted: ${reference.schema}`;
		}
		if (!identifierPattern.test(reference.table)) {
			return `Table identifier is invalid: ${reference.table}`;
		}
		const fullName = reference.schema
			? `${reference.schema}.${reference.table}`.toLowerCase()
			: reference.table.toLowerCase();
		if (!tables.has(fullName) && !tables.has(reference.table.toLowerCase())) {
			return `Table is not allowlisted: ${reference.display}`;
		}
	}
	return undefined;
}

function fingerprintSql(sql: string): string {
	const canonical = sql
		.toLowerCase()
		.replace(/\$\d+\b/g, "?")
		.replace(/\b\d+(\.\d+)?\b/g, "?")
		.replace(/'([^']|'')*'/g, "?");
	let hash = 0x811c9dc5;
	for (const char of canonical) {
		hash ^= char.charCodeAt(0);
		hash = Math.imul(hash, 0x01000193);
	}
	return `q_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export const defaultMaskColumns = [
	"email",
	"phone",
	"mobile",
	"name",
	"first_name",
	"last_name",
	"password",
	"token",
	"secret",
	"access_token",
	"refresh_token",
] as const;

function shouldMaskColumn(key: string, masked: ReadonlySet<string>): boolean {
	const normalized = key.toLowerCase();
	return (
		masked.has(normalized) ||
		normalized.includes("email") ||
		normalized.includes("phone") ||
		normalized.includes("token") ||
		normalized.includes("secret") ||
		normalized.includes("password")
	);
}

function maskValue(value: unknown): string | null {
	return value === null || value === undefined ? null : "[masked]";
}

function redactIdentifier(value: string): string {
	return value.replace(/[a-zA-Z0-9_]{4,}/g, (part) => `${part.slice(0, 2)}...`);
}

function isPositiveInt(value: number): boolean {
	return Number.isInteger(value) && value > 0;
}
