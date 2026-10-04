export type QueryParameter =
	| string
	| number
	| boolean
	| null
	| readonly (string | number | boolean | null)[];

export type QueryLimits = {
	maxRows: number;
	maxBytes: number;
	timeoutMs: number;
};

export type DbReadRequest = {
	version: "DB_READ_REQUEST_V1";
	datasource: string;
	sql: string;
	params?: readonly QueryParameter[];
	limits: QueryLimits;
	requestId: string;
	requestedBy: string;
	fingerprint: string;
};

export type ValidatedQuery = {
	datasource: string;
	sql: string;
	params: readonly QueryParameter[];
	limits: QueryLimits;
	requestId: string;
	requestedBy: string;
	fingerprint: string;
};

export type ValidationConfig = {
	datasources: readonly {
		alias: string;
		allowedSchemas: readonly string[];
		allowedTables: readonly string[];
	}[];
	maxRows: number;
	maxBytes: number;
	timeoutMs: number;
};

export type ValidationResult =
	| { ok: true; query: ValidatedQuery }
	| { ok: false; status: number; reason: string };

const datasourcePattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const mutationPattern =
	/\b(insert|update|delete|merge|upsert|alter|create|drop|truncate|grant|revoke|vacuum|analyze|refresh|reindex|listen|notify|call|do|execute|prepare|deallocate|copy)\b/i;
const transactionPattern =
	/\b(begin|commit|rollback|savepoint|release\s+savepoint|set\s+transaction|lock)\b/i;
const unsafeFunctionPattern =
	/\b(pg_sleep|pg_read_file|pg_ls_dir|pg_stat_file|dblink|lo_import|lo_export|copy_to|copy_from)\s*\(/i;
const selectIntoPattern = /\bselect\b[\s\S]*\binto\b/i;
const placeholderPattern = /\$(\d+)\b/g;

export function validateDbReadRequest(
	body: unknown,
	config: ValidationConfig,
): ValidationResult {
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return reject(400, "request body must be an object");
	}
	const record = body as Record<string, unknown>;
	if (record.version !== "DB_READ_REQUEST_V1") {
		return reject(400, "unsupported request version");
	}
	const datasource = stringField(record, "datasource");
	if (!datasourcePattern.test(datasource)) {
		return reject(400, "datasource alias is invalid");
	}
	const datasourcePolicy = config.datasources.find(
		(item) => item.alias === datasource,
	);
	if (!datasourcePolicy) {
		return reject(404, "datasource is not configured");
	}
	const sql = normalizeSql(stringField(record, "sql"));
	if (!sql) {
		return reject(400, "SQL is required");
	}
	if (sql.length > 20_000) {
		return reject(413, "SQL exceeds the maximum length");
	}
	const sqlSafety = validateSql(sql);
	if (sqlSafety) {
		return reject(400, sqlSafety);
	}
	const tableSafety = validateTableReferences(sql, datasourcePolicy);
	if (tableSafety) {
		return reject(400, tableSafety);
	}
	const params = Array.isArray(record.params)
		? (record.params as readonly unknown[])
		: [];
	const paramSafety = validateParameters(sql, params);
	if (paramSafety) {
		return reject(400, paramSafety);
	}
	const limits = parseLimits(record.limits, config);
	if (!limits.ok) {
		return limits;
	}
	const requestId = stringField(record, "requestId");
	if (!/^[a-zA-Z0-9:._-]{1,160}$/.test(requestId)) {
		return reject(400, "requestId is invalid");
	}
	const requestedBy = stringField(record, "requestedBy");
	if (!/^[a-zA-Z0-9:._@-]{1,160}$/.test(requestedBy)) {
		return reject(400, "requestedBy is invalid");
	}
	const fingerprint = stringField(record, "fingerprint");
	if (fingerprint && fingerprint !== fingerprintSql(sql)) {
		return reject(409, "SQL fingerprint does not match request");
	}
	if (!fingerprint) {
		return reject(400, "SQL fingerprint is required");
	}
	return {
		ok: true,
		query: {
			datasource,
			sql,
			params: params as readonly QueryParameter[],
			limits: limits.limits,
			requestId,
			requestedBy,
			fingerprint,
		},
	};
}

export function fingerprintSql(sql: string): string {
	const canonical = normalizeSql(sql)
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

export function renderSqlLiteral(value: QueryParameter): string {
	if (Array.isArray(value)) {
		return `ARRAY[${value.map(renderScalarLiteral).join(",")}]`;
	}
	return renderScalarLiteral(value);
}

function renderScalarLiteral(value: string | number | boolean | null): string {
	if (value === null) return "NULL";
	if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new Error("invalid numeric parameter");
		}
		return String(value);
	}
	return `'${value.replace(/'/g, "''")}'`;
}

function validateSql(sql: string): string | undefined {
	if (hasSqlComment(sql)) return "SQL comments are not allowed";
	if (hasMultipleStatements(sql)) return "Only one SQL statement is allowed";
	if (!/^(select|with)\b/i.test(sql))
		return "Only SELECT or WITH queries are allowed";
	if (mutationPattern.test(sql) || transactionPattern.test(sql)) {
		return "SQL contains a blocked operation";
	}
	if (selectIntoPattern.test(sql)) return "SELECT INTO is not allowed";
	if (unsafeFunctionPattern.test(sql)) return "SQL contains a blocked function";
	const relationSyntaxError = validateSupportedRelationSyntax(sql);
	if (relationSyntaxError) return relationSyntaxError;
	return undefined;
}

function validateSupportedRelationSyntax(sql: string): string | undefined {
	if (sql.includes('"')) return "Quoted SQL identifiers are not supported";
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

function validateTableReferences(
	sql: string,
	policy: {
		allowedSchemas: readonly string[];
		allowedTables: readonly string[];
	},
): string | undefined {
	const cteAliases = new Set<string>();
	if (/^with\b/i.test(sql)) {
		for (const match of sql.matchAll(
			/(?:with|,)\s+([a-zA-Z_][\w]*)\s+as\s*\(/gi,
		)) {
			if (match[1]) cteAliases.add(match[1].toLowerCase());
		}
	}
	const schemas = new Set(
		policy.allowedSchemas.map((item) => item.toLowerCase()),
	);
	const tables = new Set(
		policy.allowedTables.map((item) => item.toLowerCase()),
	);
	let references = 0;
	for (const match of sql.matchAll(
		/\b(from|join)\s+([a-zA-Z_][\w]*)(?:\.([a-zA-Z_][\w]*))?/gi,
	)) {
		const first = match[2] ?? "";
		const second = match[3];
		if (!second && cteAliases.has(first.toLowerCase())) continue;
		references += 1;
		if (second && !schemas.has(first.toLowerCase())) {
			return `Schema is not allowlisted: ${first}`;
		}
		const table = second ?? first;
		const fullName = second
			? `${first}.${second}`.toLowerCase()
			: table.toLowerCase();
		if (!tables.has(fullName) && !tables.has(table.toLowerCase())) {
			return `Table is not allowlisted: ${second ? `${first}.${second}` : table}`;
		}
	}
	return references > 0 ? undefined : "Query must reference an allowed table";
}

function parseLimits(
	value: unknown,
	config: ValidationConfig,
):
	| { ok: true; limits: QueryLimits }
	| { ok: false; status: number; reason: string } {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return reject(400, "limits are required");
	}
	const record = value as Record<string, unknown>;
	const maxRows = numberField(record, "maxRows");
	const maxBytes = numberField(record, "maxBytes");
	const timeoutMs = numberField(record, "timeoutMs");
	if (
		![maxRows, maxBytes, timeoutMs].every(
			(item) => Number.isInteger(item) && item > 0,
		)
	) {
		return reject(400, "limits must be positive integers");
	}
	if (
		maxRows > config.maxRows ||
		maxBytes > config.maxBytes ||
		timeoutMs > config.timeoutMs
	) {
		return reject(400, "requested limits exceed adapter ceilings");
	}
	return { ok: true, limits: { maxRows, maxBytes, timeoutMs } };
}

function validateParameters(
	sql: string,
	params: readonly unknown[],
): string | undefined {
	if (params.length > 100) return "Too many query parameters";
	const seen = new Set<number>();
	for (const match of sql.matchAll(placeholderPattern)) {
		seen.add(Number(match[1]));
	}
	if (seen.size > 0) {
		const max = Math.max(...seen);
		for (let index = 1; index <= max; index += 1) {
			if (!seen.has(index)) return "Query parameters must be contiguous";
		}
		if (max !== params.length)
			return "Parameter count does not match SQL placeholders";
	} else if (params.length > 0) {
		return "Parameters were provided but SQL has no placeholders";
	}
	for (const param of params) {
		if (!isSafeParameter(param))
			return "Query parameter contains an unsupported value";
	}
	return undefined;
}

function isSafeParameter(value: unknown): value is QueryParameter {
	if (Array.isArray(value)) {
		return value.length <= 100 && value.every(isSafeScalar);
	}
	return isSafeScalar(value);
}

function isSafeScalar(
	value: unknown,
): value is string | number | boolean | null {
	if (value === null || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	return (
		typeof value === "string" &&
		value.length <= 4_000 &&
		!containsControlCharacter(value)
	);
}

function containsControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		if (value.charCodeAt(index) <= 0x1f) return true;
	}
	return false;
}

function normalizeSql(sql: string): string {
	return sql.replace(/\s+/g, " ").trim().replace(/;+$/, "");
}

function hasSqlComment(sql: string): boolean {
	return /--|\/\*|\*\//.test(sql);
}

function hasMultipleStatements(sql: string): boolean {
	return sql.trim().replace(/;+$/, "").includes(";");
}

function stringField(record: Record<string, unknown>, field: string): string {
	const value = record[field];
	return typeof value === "string" ? value.trim() : "";
}

function numberField(record: Record<string, unknown>, field: string): number {
	const value = record[field];
	return typeof value === "number" ? value : Number.NaN;
}

function reject(
	status: number,
	reason: string,
): { ok: false; status: number; reason: string } {
	return { ok: false, status, reason };
}
