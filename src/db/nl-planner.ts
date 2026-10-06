import {
	planReadOnlyQuery,
	type QueryExecutionPlan,
	type QueryParameter,
	type QueryPolicyConfig,
} from "./query-policy";

export const naturalLanguageDbPlanVersion = "DB_NL_PLAN_V1" as const;

export type DbColumn = {
	name: string;
	type?: string;
	description?: string;
	sensitive?: boolean;
};

export type DbTable = {
	schema: string;
	name: string;
	description?: string;
	columns: readonly DbColumn[];
};

export type DbSchemaCatalog = {
	datasource: string;
	tables: readonly DbTable[];
};

export type DbQueryApproval = {
	required: true;
	reason: string;
	operationDigest: string;
	approvedBy?: string;
	approvedAt?: string;
};

export type NaturalLanguageDbQueryPlan = {
	version: typeof naturalLanguageDbPlanVersion;
	status: "proposed";
	requestId: string;
	requestedBy: string;
	createdAt: string;
	question: string;
	catalogDigest: string;
	planDigest: string;
	sql: string;
	params: readonly QueryParameter[];
	policyPlan: QueryExecutionPlan;
	referencedTables: readonly string[];
	selectedColumns: readonly string[];
	assumptions: readonly string[];
	warnings: readonly string[];
	approval: DbQueryApproval;
};

export type NaturalLanguageDbQueryPlanResult =
	| { ok: true; plan: NaturalLanguageDbQueryPlan }
	| { ok: false; reason: string; warnings?: readonly string[] };

export type DatabasePlanningContext = {
	catalog: DbSchemaCatalog;
	policy: QueryPolicyConfig;
};

export function parseDbSchemaCatalogJson(value: string): DbSchemaCatalog {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error("DATABASE_SCHEMA_CATALOG_JSON must be valid JSON");
	}
	if (!isRecord(parsed) || !Array.isArray(parsed.tables)) {
		throw new Error(
			"DATABASE_SCHEMA_CATALOG_JSON must contain datasource and tables",
		);
	}
	const catalog: DbSchemaCatalog = {
		datasource: typeof parsed.datasource === "string" ? parsed.datasource : "",
		tables: parsed.tables.map(parseCatalogTable),
	};
	const error = validateCatalog(catalog);
	if (error) {
		throw new Error(`Invalid DATABASE_SCHEMA_CATALOG_JSON: ${error}`);
	}
	return catalog;
}

export async function planNaturalLanguageDatabaseQuery(input: {
	question: string;
	catalog: DbSchemaCatalog;
	policy: QueryPolicyConfig;
	requestId: string;
	requestedBy: string;
	now?: string;
	sqlProposal?: string;
	params?: readonly QueryParameter[];
}): Promise<NaturalLanguageDbQueryPlanResult> {
	const question = input.question.trim();
	if (!question) {
		return { ok: false, reason: "Question is required" };
	}
	if (!input.requestId.trim() || !input.requestedBy.trim()) {
		return { ok: false, reason: "requestId and requestedBy are required" };
	}
	const catalogError = validateCatalog(input.catalog);
	if (catalogError) {
		return { ok: false, reason: catalogError };
	}

	const proposal = input.sqlProposal
		? {
				ok: true as const,
				sql: input.sqlProposal,
				params: input.params ?? [],
				selectedColumns: [] as string[],
				referencedTables: [] as string[],
				assumptions: ["SQL proposal was supplied by an upstream planner."],
				warnings: [] as string[],
			}
		: proposeSqlFromQuestion(question, input.catalog, input.policy);
	if (!proposal.ok) {
		return proposal;
	}

	const policyResult = planReadOnlyQuery({
		sql: proposal.sql,
		params: proposal.params,
		policy: input.policy,
	});
	if (!policyResult.ok) {
		return {
			ok: false,
			reason: `Proposed query violates policy: ${policyResult.reason}`,
			warnings: proposal.warnings,
		};
	}

	const createdAt = input.now ?? new Date().toISOString();
	const catalogDigest = await digestStable({
		datasource: input.catalog.datasource,
		tables: input.catalog.tables.map((table) => ({
			schema: table.schema,
			name: table.name,
			columns: table.columns.map((column) => ({
				name: column.name,
				type: column.type ?? "",
				sensitive: column.sensitive === true,
			})),
		})),
	});
	const digestInput = {
		version: naturalLanguageDbPlanVersion,
		requestId: input.requestId,
		requestedBy: input.requestedBy,
		question,
		sql: policyResult.plan.sql,
		params: policyResult.plan.params,
		policy: {
			datasource: policyResult.plan.datasource,
			allowedSchemas: policyResult.plan.allowedSchemas,
			allowedTables: policyResult.plan.allowedTables,
			maxRows: policyResult.plan.maxRows,
			maxBytes: policyResult.plan.maxBytes,
			timeoutMs: policyResult.plan.timeoutMs,
		},
		catalogDigest,
	};
	const planDigest = await digestStable(digestInput);

	return {
		ok: true,
		plan: {
			version: naturalLanguageDbPlanVersion,
			status: "proposed",
			requestId: input.requestId,
			requestedBy: input.requestedBy,
			createdAt,
			question,
			catalogDigest,
			planDigest,
			sql: policyResult.plan.sql,
			params: policyResult.plan.params,
			policyPlan: policyResult.plan,
			referencedTables:
				proposal.referencedTables.length > 0
					? proposal.referencedTables
					: policyResult.plan.audit.referencedTables,
			selectedColumns: proposal.selectedColumns,
			assumptions: proposal.assumptions,
			warnings: proposal.warnings,
			approval: {
				required: true,
				reason:
					"Human approval is required before any read-only database adapter executes this proposed query.",
				operationDigest: planDigest,
			},
		},
	};
}

export async function verifyNaturalLanguageDatabaseQueryPlan(
	plan: NaturalLanguageDbQueryPlan,
	context: DatabasePlanningContext,
): Promise<boolean> {
	const verified = await planNaturalLanguageDatabaseQuery({
		question: plan.question,
		catalog: context.catalog,
		policy: context.policy,
		requestId: plan.requestId,
		requestedBy: plan.requestedBy,
		now: plan.createdAt,
		sqlProposal: plan.sql,
		params: plan.params,
	});
	return (
		verified.ok &&
		verified.plan.planDigest === plan.planDigest &&
		verified.plan.catalogDigest === plan.catalogDigest &&
		plan.approval.operationDigest === plan.planDigest
	);
}

type SqlProposal =
	| {
			ok: true;
			sql: string;
			params: readonly QueryParameter[];
			selectedColumns: readonly string[];
			referencedTables: readonly string[];
			assumptions: readonly string[];
			warnings: readonly string[];
	  }
	| { ok: false; reason: string; warnings?: readonly string[] };

function proposeSqlFromQuestion(
	question: string,
	catalog: DbSchemaCatalog,
	policy: QueryPolicyConfig,
): SqlProposal {
	const table = chooseTable(question, catalog, policy);
	if (!table) {
		return {
			ok: false,
			reason:
				"Could not map the question to exactly one allowlisted catalog table",
		};
	}
	const columns = chooseColumns(question, table);
	const sql = `SELECT ${columns.map(quoteIdentifier).join(", ")} FROM ${quoteIdentifier(
		table.schema,
	)}.${quoteIdentifier(table.name)} LIMIT ${Math.min(policy.maxRows, 100)}`;
	return {
		ok: true,
		sql,
		params: [],
		selectedColumns: columns,
		referencedTables: [`${table.schema}.${table.name}`],
		assumptions: [
			"Planner selected one allowlisted table from catalog keyword overlap.",
			"Planner generated a bounded preview query; refine with an explicit SQL proposal for complex joins or filters.",
		],
		warnings: table.columns.some((column) => column.sensitive)
			? [
					"Selected table contains sensitive columns; response rows must be masked.",
				]
			: [],
	};
}

function chooseTable(
	question: string,
	catalog: DbSchemaCatalog,
	policy: QueryPolicyConfig,
): DbTable | undefined {
	const allowedTables = new Set(
		policy.allowedTables.map((value) => value.toLowerCase()),
	);
	const allowedSchemas = new Set(
		policy.allowedSchemas.map((value) => value.toLowerCase()),
	);
	const tokens = tokenize(question);
	const scored = catalog.tables
		.filter((table) => {
			const fullName = `${table.schema}.${table.name}`.toLowerCase();
			return (
				allowedSchemas.has(table.schema.toLowerCase()) &&
				(allowedTables.has(fullName) ||
					allowedTables.has(table.name.toLowerCase()))
			);
		})
		.map((table) => ({ table, score: scoreTable(table, tokens) }))
		.filter((item) => item.score > 0)
		.sort((a, b) => b.score - a.score);
	if (scored.length === 0) {
		return undefined;
	}
	if (scored.length > 1 && scored[0]?.score === scored[1]?.score) {
		return undefined;
	}
	return scored[0]?.table;
}

function chooseColumns(question: string, table: DbTable): string[] {
	const tokens = tokenize(question);
	const matched = table.columns
		.filter((column) => !column.sensitive)
		.filter((column) =>
			[...tokenize(column.name)].some((token) => tokens.has(token)),
		)
		.map((column) => column.name)
		.slice(0, 8);
	if (matched.length > 0) {
		return matched;
	}
	const safeColumns = table.columns
		.filter((column) => !column.sensitive)
		.map((column) => column.name)
		.slice(0, 8);
	return safeColumns.length > 0 ? safeColumns : ["id"];
}

function scoreTable(table: DbTable, tokens: ReadonlySet<string>): number {
	let score = 0;
	for (const token of tokenize(
		`${table.schema} ${table.name} ${table.description ?? ""}`,
	)) {
		if (tokens.has(token)) score += 3;
	}
	for (const column of table.columns) {
		for (const token of tokenize(
			`${column.name} ${column.description ?? ""}`,
		)) {
			if (tokens.has(token)) score += 1;
		}
	}
	return score;
}

export function validateCatalog(catalog: DbSchemaCatalog): string | undefined {
	if (!catalog.datasource.trim()) {
		return "Catalog datasource is required";
	}
	if (catalog.tables.length === 0) {
		return "Catalog must contain at least one table";
	}
	for (const table of catalog.tables) {
		if (!isIdentifier(table.schema) || !isIdentifier(table.name)) {
			return `Invalid table identifier: ${table.schema}.${table.name}`;
		}
		if (table.columns.length === 0) {
			return `Table ${table.schema}.${table.name} must contain columns`;
		}
		for (const column of table.columns) {
			if (!isIdentifier(column.name)) {
				return `Invalid column identifier: ${column.name}`;
			}
		}
	}
	return undefined;
}

function parseCatalogTable(value: unknown): DbTable {
	if (!isRecord(value) || !Array.isArray(value.columns)) {
		throw new Error(
			"DATABASE_SCHEMA_CATALOG_JSON tables must contain schema, name, and columns",
		);
	}
	return {
		schema: typeof value.schema === "string" ? value.schema : "",
		name: typeof value.name === "string" ? value.name : "",
		...(typeof value.description === "string"
			? { description: value.description }
			: {}),
		columns: value.columns.map(parseCatalogColumn),
	};
}

function parseCatalogColumn(value: unknown): DbColumn {
	if (!isRecord(value)) {
		throw new Error(
			"DATABASE_SCHEMA_CATALOG_JSON columns must be JSON objects",
		);
	}
	return {
		name: typeof value.name === "string" ? value.name : "",
		...(typeof value.type === "string" ? { type: value.type } : {}),
		...(typeof value.description === "string"
			? { description: value.description }
			: {}),
		...(typeof value.sensitive === "boolean"
			? { sensitive: value.sensitive }
			: {}),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function quoteIdentifier(value: string): string {
	return value;
}

function isIdentifier(value: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function tokenize(value: string): Set<string> {
	return new Set(
		value
			.toLowerCase()
			.split(/[^\p{L}\p{N}_]+/u)
			.flatMap((part) => part.split("_"))
			.filter((part) => part.length >= 2),
	);
}

async function digestStable(value: unknown): Promise<string> {
	const bytes = new TextEncoder().encode(stableStringify(value));
	const hash = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(hash)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(",")}]`;
	}
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
		.join(",")}}`;
}
