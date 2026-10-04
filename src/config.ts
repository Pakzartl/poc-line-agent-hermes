import { parseDbSchemaCatalogJson } from "./db/nl-planner";

export type AppConfig = {
	port: number;
	runtime: {
		mode: AgentRuntimeMode;
	};
	line: {
		channelSecret: string;
		channelAccessToken: string;
		apiBaseUrl: string;
	};
	telegram: {
		botToken: string;
		webhookSecret: string;
		allowedUserIds: readonly string[];
		apiBaseUrl: string;
	};
	discord: {
		applicationId: string;
		publicKey: string;
		botToken: string;
		gatewaySharedSecret: string;
		allowedUserIds: readonly string[];
		allowedGuildIds: readonly string[];
		apiBaseUrl: string;
	};
	whatsapp: {
		accessToken: string;
		phoneNumberId: string;
		verifyToken: string;
		appSecret: string;
		apiBaseUrl: string;
	};
	llm: {
		apiKey: string;
		baseUrl: string;
		model: string;
		maxToolRounds: number;
		maxToolCalls: number;
	};
	github: {
		owner: string;
		repo: string;
		token: string;
		ref: string;
		apiBaseUrl: string;
	};
	memory: {
		directory: string;
		maxMessages: number;
	};
	hermes: {
		baseUrl: string;
		apiServerKey: string;
		telegramAllowedUserIds: readonly string[];
	};
	events?: {
		queueFailureSecret: string;
		queueFailureDiscordChannelId: string;
	};
	capabilities?: {
		databaseAdapterUrl: string;
		databaseAdapterToken: string;
		databaseDatasource: string;
		databaseAllowedSchemas: readonly string[];
		databaseAllowedTables: readonly string[];
		databaseSchemaCatalogJson: string;
		artifactRendererUrl: string;
		artifactRendererToken: string;
		artifactScreenshotTargetsJson: string;
		deployTargetsJson: string;
		deployExecutorToken: string;
	};
};

export type AgentRuntimeMode = "legacy" | "hermes" | "fallback";

const defaultOpenAiBaseUrl = "https://api.openai.com/v1";
const defaultLineApiBaseUrl = "https://api.line.me";
const defaultTelegramApiBaseUrl = "https://api.telegram.org";
const defaultDiscordApiBaseUrl = "https://discord.com/api/v10";
const defaultWhatsAppApiBaseUrl = "https://graph.facebook.com/v26.0";

export type ConfigEnvironment = Readonly<Record<string, string | undefined>>;

export function loadConfig(env: ConfigEnvironment): AppConfig {
	return {
		port: Number(env.PORT ?? "3000"),
		runtime: {
			mode: parseRuntimeMode(env.AGENT_RUNTIME),
		},
		line: {
			channelSecret: env.LINE_CHANNEL_SECRET ?? "",
			channelAccessToken: env.LINE_CHANNEL_ACCESS_TOKEN ?? "",
			apiBaseUrl: stripTrailingSlash(
				env.LINE_API_BASE_URL ?? defaultLineApiBaseUrl,
			),
		},
		telegram: {
			botToken: env.TELEGRAM_BOT_TOKEN ?? "",
			webhookSecret: env.TELEGRAM_WEBHOOK_SECRET ?? "",
			allowedUserIds: parseList(env.TELEGRAM_ALLOWED_USER_IDS),
			apiBaseUrl: stripTrailingSlash(
				env.TELEGRAM_API_BASE_URL ?? defaultTelegramApiBaseUrl,
			),
		},
		discord: {
			applicationId: env.DISCORD_APPLICATION_ID ?? "",
			publicKey: env.DISCORD_PUBLIC_KEY ?? "",
			botToken: env.DISCORD_BOT_TOKEN ?? "",
			gatewaySharedSecret: env.DISCORD_GATEWAY_SHARED_SECRET ?? "",
			allowedUserIds: parseList(env.DISCORD_ALLOWED_USER_IDS),
			allowedGuildIds: parseList(env.DISCORD_ALLOWED_GUILD_IDS),
			apiBaseUrl: stripTrailingSlash(
				env.DISCORD_API_BASE_URL ?? defaultDiscordApiBaseUrl,
			),
		},
		whatsapp: {
			accessToken: env.WHATSAPP_ACCESS_TOKEN ?? "",
			phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID ?? "",
			verifyToken: env.WHATSAPP_VERIFY_TOKEN ?? "",
			appSecret: env.WHATSAPP_APP_SECRET ?? "",
			apiBaseUrl: stripTrailingSlash(
				env.WHATSAPP_API_BASE_URL ?? defaultWhatsAppApiBaseUrl,
			),
		},
		llm: {
			apiKey: env.OPENAI_API_KEY ?? "",
			baseUrl: stripTrailingSlash(env.OPENAI_BASE_URL ?? defaultOpenAiBaseUrl),
			model: env.OPENAI_MODEL ?? "gpt-5.4-mini",
			maxToolRounds: Number(env.OPENAI_MAX_TOOL_ROUNDS ?? "50"),
			maxToolCalls: Number(env.OPENAI_MAX_TOOL_CALLS ?? "100"),
		},
		github: {
			owner: env.GITHUB_OWNER ?? "",
			repo: env.GITHUB_REPO ?? "",
			token: env.GITHUB_TOKEN ?? "",
			ref: env.GITHUB_REF ?? "main",
			apiBaseUrl: stripTrailingSlash(
				env.GITHUB_API_BASE_URL ?? "https://api.github.com",
			),
		},
		memory: {
			directory: env.SESSION_MEMORY_DIR ?? ".sessions",
			maxMessages: Number(env.SESSION_MEMORY_MAX_MESSAGES ?? "12"),
		},
		hermes: {
			baseUrl: stripTrailingSlash(env.HERMES_BASE_URL ?? ""),
			apiServerKey: env.HERMES_API_SERVER_KEY ?? "",
			telegramAllowedUserIds: parseList(env.HERMES_TELEGRAM_ALLOWED_USER_IDS),
		},
		events: {
			queueFailureSecret: env.QUEUE_FAILURE_EVENT_SECRET ?? "",
			queueFailureDiscordChannelId: env.QUEUE_FAILURE_DISCORD_CHANNEL_ID ?? "",
		},
		capabilities: {
			databaseAdapterUrl: stripTrailingSlash(env.DATABASE_ADAPTER_URL ?? ""),
			databaseAdapterToken: env.DATABASE_ADAPTER_TOKEN ?? "",
			databaseDatasource: env.DATABASE_DATASOURCE ?? "",
			databaseAllowedSchemas: parseList(env.DATABASE_ALLOWED_SCHEMAS),
			databaseAllowedTables: parseList(env.DATABASE_ALLOWED_TABLES),
			databaseSchemaCatalogJson: env.DATABASE_SCHEMA_CATALOG_JSON ?? "",
			artifactRendererUrl: stripTrailingSlash(env.ARTIFACT_RENDERER_URL ?? ""),
			artifactRendererToken: env.ARTIFACT_RENDERER_TOKEN ?? "",
			artifactScreenshotTargetsJson: env.ARTIFACT_SCREENSHOT_TARGETS_JSON ?? "",
			deployTargetsJson: env.DEPLOY_TARGETS_JSON ?? "",
			deployExecutorToken: env.DEPLOY_EXECUTOR_TOKEN ?? "",
		},
	};
}

export function validateConfig(config: AppConfig): void {
	const requiredValues: [string, string][] = [];
	if (routeUsesLegacySecrets(config)) {
		requiredValues.push(
			["OPENAI_API_KEY", config.llm.apiKey],
			["OPENAI_MODEL", config.llm.model],
			["GITHUB_TOKEN", config.github.token],
		);
	}
	const missing = requiredValues
		.filter(([, value]) => !value.trim())
		.map(([name]) => name);

	if (missing.length > 0) {
		throw new Error(
			`Missing required environment variables: ${missing.join(", ")}`,
		);
	}

	const providers = [
		{
			name: "LINE",
			values: [
				["LINE_CHANNEL_SECRET", config.line.channelSecret],
				["LINE_CHANNEL_ACCESS_TOKEN", config.line.channelAccessToken],
			],
		},
		{
			name: "Telegram",
			values: [
				["TELEGRAM_BOT_TOKEN", config.telegram.botToken],
				["TELEGRAM_WEBHOOK_SECRET", config.telegram.webhookSecret],
			],
		},
		{
			name: "Discord",
			values: [
				["DISCORD_APPLICATION_ID", config.discord.applicationId],
				["DISCORD_PUBLIC_KEY", config.discord.publicKey],
				["DISCORD_ALLOWED_USER_IDS", config.discord.allowedUserIds.join(",")],
			],
		},
		{
			name: "WhatsApp",
			values: [
				["WHATSAPP_ACCESS_TOKEN", config.whatsapp.accessToken],
				["WHATSAPP_PHONE_NUMBER_ID", config.whatsapp.phoneNumberId],
				["WHATSAPP_VERIFY_TOKEN", config.whatsapp.verifyToken],
				["WHATSAPP_APP_SECRET", config.whatsapp.appSecret],
			],
		},
	] as const;
	let configuredProviders = 0;

	for (const provider of providers) {
		const present = provider.values.filter(([, value]) => value.trim());
		if (present.length === 0) {
			continue;
		}
		const providerMissing = provider.values
			.filter(([, value]) => !value.trim())
			.map(([name]) => name);
		if (providerMissing.length > 0) {
			throw new Error(
				`Incomplete ${provider.name} configuration: ${providerMissing.join(", ")}`,
			);
		}
		configuredProviders += 1;
	}

	const discordGatewayValues: [string, string][] = [
		["DISCORD_BOT_TOKEN", config.discord.botToken],
		["DISCORD_GATEWAY_SHARED_SECRET", config.discord.gatewaySharedSecret],
		["DISCORD_ALLOWED_GUILD_IDS", config.discord.allowedGuildIds.join(",")],
	];
	const presentDiscordGatewayValues = discordGatewayValues.filter(([, value]) =>
		value.trim(),
	);
	if (
		presentDiscordGatewayValues.length > 0 &&
		presentDiscordGatewayValues.length < discordGatewayValues.length
	) {
		const missingDiscordGatewayValues = discordGatewayValues
			.filter(([, value]) => !value.trim())
			.map(([name]) => name);
		throw new Error(
			`Incomplete Discord Gateway configuration: ${missingDiscordGatewayValues.join(", ")}`,
		);
	}

	if (configuredProviders === 0) {
		throw new Error(
			"Configure at least one messaging provider: LINE, Telegram, Discord, or WhatsApp",
		);
	}

	if (config.runtime.mode !== "legacy") {
		const hermesValues: [string, string][] = [
			["HERMES_BASE_URL", config.hermes.baseUrl],
			["HERMES_API_SERVER_KEY", config.hermes.apiServerKey],
		];
		const missingHermes = hermesValues
			.filter(([, value]) => !value.trim())
			.map(([name]) => name);
		if (missingHermes.length > 0) {
			throw new Error(
				`Missing required Hermes environment variables: ${missingHermes.join(", ")}`,
			);
		}
	}

	const invalidTelegramUserIds = config.telegram.allowedUserIds.filter(
		(userId) => !/^[1-9]\d{0,19}$/.test(userId),
	);
	if (invalidTelegramUserIds.length > 0) {
		throw new Error(
			"TELEGRAM_ALLOWED_USER_IDS must contain comma-separated positive integers",
		);
	}

	const invalidDiscordUserIds = config.discord.allowedUserIds.filter(
		(userId) => !/^[1-9]\d{0,19}$/.test(userId),
	);
	if (invalidDiscordUserIds.length > 0) {
		throw new Error(
			"DISCORD_ALLOWED_USER_IDS must contain comma-separated positive integers",
		);
	}
	const invalidDiscordGuildIds = config.discord.allowedGuildIds.filter(
		(guildId) => !/^[1-9]\d{0,19}$/.test(guildId),
	);
	if (invalidDiscordGuildIds.length > 0) {
		throw new Error(
			"DISCORD_ALLOWED_GUILD_IDS must contain comma-separated positive integers",
		);
	}
	if (
		config.discord.gatewaySharedSecret &&
		config.discord.gatewaySharedSecret.length < 32
	) {
		throw new Error(
			"DISCORD_GATEWAY_SHARED_SECRET must contain at least 32 characters",
		);
	}
	if (
		config.discord.applicationId &&
		!/^[1-9]\d{0,19}$/.test(config.discord.applicationId)
	) {
		throw new Error("DISCORD_APPLICATION_ID must be a positive integer");
	}
	if (
		config.discord.publicKey &&
		!/^[0-9a-f]{64}$/i.test(config.discord.publicKey)
	) {
		throw new Error("DISCORD_PUBLIC_KEY must be a 32-byte hexadecimal key");
	}
	if (
		config.events?.queueFailureDiscordChannelId &&
		!/^[1-9]\d{5,19}$/.test(config.events.queueFailureDiscordChannelId)
	) {
		throw new Error(
			"QUEUE_FAILURE_DISCORD_CHANNEL_ID must be a Discord snowflake",
		);
	}
	validateOptionalCapabilityConfig(config);

	if (
		!Number.isInteger(config.port) ||
		config.port < 1 ||
		config.port > 65_535
	) {
		throw new Error("PORT must be an integer between 1 and 65535");
	}

	if (
		!Number.isInteger(config.llm.maxToolRounds) ||
		config.llm.maxToolRounds < 0 ||
		config.llm.maxToolRounds > 50
	) {
		throw new Error(
			"OPENAI_MAX_TOOL_ROUNDS must be an integer between 0 and 50",
		);
	}

	if (
		!Number.isInteger(config.llm.maxToolCalls) ||
		config.llm.maxToolCalls < 1 ||
		config.llm.maxToolCalls > 200
	) {
		throw new Error(
			"OPENAI_MAX_TOOL_CALLS must be an integer between 1 and 200",
		);
	}

	if (
		!Number.isInteger(config.memory.maxMessages) ||
		config.memory.maxMessages < 2 ||
		config.memory.maxMessages > 100
	) {
		throw new Error(
			"SESSION_MEMORY_MAX_MESSAGES must be an integer between 2 and 100",
		);
	}

	if (!config.memory.directory.trim()) {
		throw new Error("SESSION_MEMORY_DIR is required");
	}

	const invalidHermesTelegramUserIds =
		config.hermes.telegramAllowedUserIds.filter(
			(userId) => !/^[1-9]\d{0,19}$/.test(userId),
		);
	if (invalidHermesTelegramUserIds.length > 0) {
		throw new Error(
			"HERMES_TELEGRAM_ALLOWED_USER_IDS must contain comma-separated positive integers",
		);
	}

	const urlsToValidate: [string, string][] = [
		["OPENAI_BASE_URL", config.llm.baseUrl],
		["LINE_API_BASE_URL", config.line.apiBaseUrl],
		["TELEGRAM_API_BASE_URL", config.telegram.apiBaseUrl],
		["DISCORD_API_BASE_URL", config.discord.apiBaseUrl],
		["WHATSAPP_API_BASE_URL", config.whatsapp.apiBaseUrl],
		["GITHUB_API_BASE_URL", config.github.apiBaseUrl],
	];
	if (config.runtime.mode !== "legacy") {
		urlsToValidate.push(["HERMES_BASE_URL", config.hermes.baseUrl]);
	}
	for (const [name, value] of urlsToValidate) {
		try {
			new URL(value);
		} catch {
			throw new Error(`${name} must be a valid URL`);
		}
	}
}

function validateOptionalCapabilityConfig(config: AppConfig): void {
	const capabilities = config.capabilities;
	if (!capabilities) return;
	validateOptionalPair("database adapter", [
		["DATABASE_ADAPTER_URL", capabilities.databaseAdapterUrl],
		["DATABASE_ADAPTER_TOKEN", capabilities.databaseAdapterToken],
		["DATABASE_DATASOURCE", capabilities.databaseDatasource],
		["DATABASE_ALLOWED_SCHEMAS", capabilities.databaseAllowedSchemas.join(",")],
		["DATABASE_ALLOWED_TABLES", capabilities.databaseAllowedTables.join(",")],
		["DATABASE_SCHEMA_CATALOG_JSON", capabilities.databaseSchemaCatalogJson],
	]);
	if (capabilities.databaseSchemaCatalogJson.trim()) {
		const catalog = parseDbSchemaCatalogJson(
			capabilities.databaseSchemaCatalogJson,
		);
		if (catalog.datasource !== capabilities.databaseDatasource) {
			throw new Error(
				"DATABASE_SCHEMA_CATALOG_JSON datasource must match DATABASE_DATASOURCE",
			);
		}
	}
	validateOptionalPair("artifact renderer", [
		["ARTIFACT_RENDERER_URL", capabilities.artifactRendererUrl],
		["ARTIFACT_RENDERER_TOKEN", capabilities.artifactRendererToken],
		[
			"ARTIFACT_SCREENSHOT_TARGETS_JSON",
			capabilities.artifactScreenshotTargetsJson,
		],
	]);
	if (
		Boolean(capabilities.deployTargetsJson.trim()) !==
		Boolean(capabilities.deployExecutorToken.trim())
	) {
		throw new Error(
			"Incomplete deploy executor configuration: DEPLOY_TARGETS_JSON and DEPLOY_EXECUTOR_TOKEN must be set together",
		);
	}
	for (const [name, value] of [
		["DATABASE_ADAPTER_URL", capabilities.databaseAdapterUrl],
		["ARTIFACT_RENDERER_URL", capabilities.artifactRendererUrl],
	] as const) {
		if (!value) continue;
		const url = new URL(value);
		if (url.protocol !== "https:" || url.username || url.password) {
			throw new Error(`${name} must use credential-free HTTPS`);
		}
	}
}

function validateOptionalPair(
	label: string,
	values: readonly (readonly [string, string])[],
): void {
	const present = values.filter(([, value]) => value.trim());
	if (present.length === 0 || present.length === values.length) return;
	const missing = values
		.filter(([, value]) => !value.trim())
		.map(([name]) => name);
	throw new Error(`Incomplete ${label} configuration: ${missing.join(", ")}`);
}

function routeUsesLegacySecrets(config: AppConfig): boolean {
	if (config.runtime.mode === "legacy" || config.runtime.mode === "fallback") {
		return true;
	}
	return (
		Boolean(config.line.channelSecret && config.line.channelAccessToken) ||
		Boolean(
			config.whatsapp.accessToken &&
				config.whatsapp.phoneNumberId &&
				config.whatsapp.verifyToken &&
				config.whatsapp.appSecret,
		)
	);
}

function stripTrailingSlash(value: string): string {
	return value.replace(/\/+$/, "");
}

function parseRuntimeMode(value: string | undefined): AgentRuntimeMode {
	if (!value) {
		return "legacy";
	}
	if (value === "legacy" || value === "hermes" || value === "fallback") {
		return value;
	}
	throw new Error("AGENT_RUNTIME must be one of: legacy, hermes, fallback");
}

function parseList(value: string | undefined): string[] {
	return (value ?? "")
		.split(/[\s,]+/)
		.map((item) => item.trim())
		.filter(Boolean);
}
