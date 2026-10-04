export type DbDatasourceConfig = {
	alias: string;
	connectionStringEnv: string;
};

export type DbAdapterConfig = {
	port: number;
	token: string;
	datasources: readonly DbDatasourceConfig[];
	limits: {
		maxRows: number;
		maxBytes: number;
		timeoutMs: number;
	};
};

const datasourcePattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const envNamePattern = /^[A-Z][A-Z0-9_]{0,127}$/;

export function loadDbAdapterConfig(
	env: Readonly<Record<string, string | undefined>>,
): DbAdapterConfig {
	const port = integerFromEnv(env.DB_ADAPTER_PORT, "DB_ADAPTER_PORT", 8789);
	if (port < 1 || port > 65_535) {
		throw new Error("DB_ADAPTER_PORT must be a valid TCP port");
	}
	const token = env.DB_ADAPTER_TOKEN?.trim() ?? "";
	if (token.length < 32) {
		throw new Error("DB_ADAPTER_TOKEN must be at least 32 characters");
	}
	return {
		port,
		token,
		datasources: parseDatasources(env.DB_ADAPTER_DATASOURCES_JSON),
		limits: {
			maxRows: ceiling(
				integerFromEnv(env.DB_ADAPTER_MAX_ROWS, "DB_ADAPTER_MAX_ROWS", 100),
				1_000,
				"DB_ADAPTER_MAX_ROWS",
			),
			maxBytes: ceiling(
				integerFromEnv(
					env.DB_ADAPTER_MAX_BYTES,
					"DB_ADAPTER_MAX_BYTES",
					250_000,
				),
				1_000_000,
				"DB_ADAPTER_MAX_BYTES",
			),
			timeoutMs: ceiling(
				integerFromEnv(
					env.DB_ADAPTER_TIMEOUT_MS,
					"DB_ADAPTER_TIMEOUT_MS",
					5_000,
				),
				10_000,
				"DB_ADAPTER_TIMEOUT_MS",
			),
		},
	};
}

export function parseDatasources(
	raw: string | undefined,
): DbDatasourceConfig[] {
	if (!raw?.trim()) {
		throw new Error("DB_ADAPTER_DATASOURCES_JSON is required");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("DB_ADAPTER_DATASOURCES_JSON must be valid JSON");
	}
	if (!Array.isArray(parsed) || parsed.length === 0) {
		throw new Error("DB_ADAPTER_DATASOURCES_JSON must be a non-empty array");
	}
	const seen = new Set<string>();
	return parsed.map((candidate, index) => {
		if (!candidate || typeof candidate !== "object") {
			throw new Error(`datasource ${index} must be an object`);
		}
		const record = candidate as Record<string, unknown>;
		const alias = typeof record.alias === "string" ? record.alias.trim() : "";
		if (!datasourcePattern.test(alias)) {
			throw new Error(`datasource ${index} alias is invalid`);
		}
		if (seen.has(alias)) {
			throw new Error(`datasource ${alias} is duplicated`);
		}
		seen.add(alias);
		const connectionStringEnv =
			typeof record.connectionStringEnv === "string"
				? record.connectionStringEnv.trim()
				: "";
		if (!envNamePattern.test(connectionStringEnv)) {
			throw new Error(
				`datasource ${alias} connectionStringEnv must be an env var name`,
			);
		}
		return { alias, connectionStringEnv };
	});
}

function integerFromEnv(
	value: string | undefined,
	name: string,
	defaultValue: number,
): number {
	if (!value?.trim()) return defaultValue;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new Error(`${name} must be a positive integer`);
	}
	return parsed;
}

function ceiling(value: number, max: number, name: string): number {
	if (value > max) {
		throw new Error(`${name} exceeds the safety ceiling`);
	}
	return value;
}
