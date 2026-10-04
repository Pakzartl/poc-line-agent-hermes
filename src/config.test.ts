import { describe, expect, test } from "bun:test";
import { loadConfig, validateConfig } from "./config";

const validEnv = {
	LINE_CHANNEL_SECRET: "line-secret",
	LINE_CHANNEL_ACCESS_TOKEN: "line-token",
	OPENAI_API_KEY: "openai-key",
	GITHUB_OWNER: "superset",
	GITHUB_REPO: "superset",
	GITHUB_TOKEN: "github-token",
};

describe("config validation", () => {
	test("accepts the documented defaults", () => {
		const config = loadConfig(validEnv);
		expect(config.llm.maxToolRounds).toBe(50);
		expect(config.llm.maxToolCalls).toBe(100);
		expect(() => validateConfig(config)).not.toThrow();
	});

	test("accepts up to fifty tool rounds and rejects larger budgets", () => {
		expect(() =>
			validateConfig(loadConfig({ ...validEnv, OPENAI_MAX_TOOL_ROUNDS: "50" })),
		).not.toThrow();
		expect(() =>
			validateConfig(loadConfig({ ...validEnv, OPENAI_MAX_TOOL_ROUNDS: "51" })),
		).toThrow("OPENAI_MAX_TOOL_ROUNDS must be an integer between 0 and 50");
	});

	test("accepts a bounded total tool-call budget", () => {
		expect(() =>
			validateConfig(loadConfig({ ...validEnv, OPENAI_MAX_TOOL_CALLS: "100" })),
		).not.toThrow();
		expect(() =>
			validateConfig(loadConfig({ ...validEnv, OPENAI_MAX_TOOL_CALLS: "201" })),
		).toThrow("OPENAI_MAX_TOOL_CALLS must be an integer between 1 and 200");
	});

	test("accepts Telegram or WhatsApp without LINE credentials", () => {
		const shared = {
			OPENAI_API_KEY: "openai-key",
			GITHUB_OWNER: "superset",
			GITHUB_REPO: "superset",
			GITHUB_TOKEN: "github-token",
		};
		expect(() =>
			validateConfig(
				loadConfig({
					...shared,
					TELEGRAM_BOT_TOKEN: "bot-token",
					TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
					TELEGRAM_ALLOWED_USER_IDS: "123, 456",
				}),
			),
		).not.toThrow();
		expect(
			loadConfig({ TELEGRAM_ALLOWED_USER_IDS: "123, 456" }).telegram
				.allowedUserIds,
		).toEqual(["123", "456"]);
		expect(() =>
			validateConfig(
				loadConfig({
					...shared,
					WHATSAPP_ACCESS_TOKEN: "access-token",
					WHATSAPP_PHONE_NUMBER_ID: "phone-id",
					WHATSAPP_VERIFY_TOKEN: "verify-token",
					WHATSAPP_APP_SECRET: "app-secret",
				}),
			),
		).not.toThrow();
	});

	test("accepts a complete Discord provider and rejects unsafe partial config", () => {
		const discordEnv = {
			...validEnv,
			LINE_CHANNEL_SECRET: "",
			LINE_CHANNEL_ACCESS_TOKEN: "",
			DISCORD_APPLICATION_ID: "123456789",
			DISCORD_PUBLIC_KEY: "ab".repeat(32),
			DISCORD_ALLOWED_USER_IDS: "9001,9002",
		};
		const config = loadConfig(discordEnv);

		expect(config.discord.allowedUserIds).toEqual(["9001", "9002"]);
		expect(() => validateConfig(config)).not.toThrow();
		expect(() =>
			validateConfig(
				loadConfig({
					...discordEnv,
					DISCORD_ALLOWED_USER_IDS: "",
				}),
			),
		).toThrow("Incomplete Discord configuration: DISCORD_ALLOWED_USER_IDS");
		expect(() =>
			validateConfig(
				loadConfig({
					...discordEnv,
					DISCORD_PUBLIC_KEY: "not-a-key",
				}),
			),
		).toThrow("DISCORD_PUBLIC_KEY must be a 32-byte hexadecimal key");
	});

	test("requires the Discord Gateway settings as one complete group", () => {
		const discordEnv = {
			...validEnv,
			DISCORD_APPLICATION_ID: "123456789",
			DISCORD_PUBLIC_KEY: "ab".repeat(32),
			DISCORD_ALLOWED_USER_IDS: "9001",
			DISCORD_BOT_TOKEN: "bot-token",
			DISCORD_GATEWAY_SHARED_SECRET: "s".repeat(32),
			DISCORD_ALLOWED_GUILD_IDS: "8001,8002",
		};
		const config = loadConfig(discordEnv);
		expect(config.discord.allowedGuildIds).toEqual(["8001", "8002"]);
		expect(() => validateConfig(config)).not.toThrow();
		expect(() =>
			validateConfig(
				loadConfig({ ...discordEnv, DISCORD_ALLOWED_GUILD_IDS: "" }),
			),
		).toThrow(
			"Incomplete Discord Gateway configuration: DISCORD_ALLOWED_GUILD_IDS",
		);
		expect(() =>
			validateConfig(
				loadConfig({
					...discordEnv,
					DISCORD_GATEWAY_SHARED_SECRET: "too-short",
				}),
			),
		).toThrow(
			"DISCORD_GATEWAY_SHARED_SECRET must contain at least 32 characters",
		);
	});

	test("rejects partial provider configuration", () => {
		expect(() =>
			validateConfig(
				loadConfig({
					...validEnv,
					TELEGRAM_BOT_TOKEN: "bot-token",
				}),
			),
		).toThrow("Incomplete Telegram configuration: TELEGRAM_WEBHOOK_SECRET");
	});

	test("rejects missing credentials and invalid numeric values", () => {
		expect(() => validateConfig(loadConfig({}))).toThrow(
			"Missing required environment variables",
		);
		expect(() =>
			validateConfig(loadConfig({ ...validEnv, PORT: "invalid" })),
		).toThrow("PORT must be an integer between 1 and 65535");
		expect(() =>
			validateConfig(
				loadConfig({ ...validEnv, SESSION_MEMORY_MAX_MESSAGES: "1" }),
			),
		).toThrow(
			"SESSION_MEMORY_MAX_MESSAGES must be an integer between 2 and 100",
		);
		expect(() =>
			validateConfig(
				loadConfig({ ...validEnv, TELEGRAM_ALLOWED_USER_IDS: "123, nope" }),
			),
		).toThrow(
			"TELEGRAM_ALLOWED_USER_IDS must contain comma-separated positive integers",
		);
	});

	test("parses runtime modes and keeps legacy as the default", () => {
		expect(loadConfig(validEnv).runtime.mode).toBe("legacy");
		expect(
			loadConfig({ ...validEnv, AGENT_RUNTIME: "hermes" }).runtime.mode,
		).toBe("hermes");
		expect(() =>
			loadConfig({ ...validEnv, AGENT_RUNTIME: "cloudrun" }),
		).toThrow("AGENT_RUNTIME must be one of: legacy, hermes, fallback");
	});

	test("requires Hermes settings only when Hermes routing is enabled", () => {
		expect(() => validateConfig(loadConfig(validEnv))).not.toThrow();
		expect(() =>
			validateConfig(
				loadConfig({
					...validEnv,
					AGENT_RUNTIME: "hermes",
				}),
			),
		).toThrow("Missing required Hermes environment variables");
		expect(() =>
			validateConfig(
				loadConfig({
					TELEGRAM_BOT_TOKEN: "bot-token",
					TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
					TELEGRAM_ALLOWED_USER_IDS: "9001",
					AGENT_RUNTIME: "hermes",
					HERMES_BASE_URL: "https://hermes.internal",
					HERMES_API_SERVER_KEY: "hermes-key",
				}),
			),
		).not.toThrow();
	});

	test("allows LINE and WhatsApp in Hermes mode when legacy secrets are present", () => {
		expect(() =>
			validateConfig(
				loadConfig({
					LINE_CHANNEL_SECRET: "line-secret",
					LINE_CHANNEL_ACCESS_TOKEN: "line-token",
					OPENAI_API_KEY: "openai-key",
					GITHUB_TOKEN: "github-token",
					AGENT_RUNTIME: "hermes",
					HERMES_BASE_URL: "https://hermes.internal",
					HERMES_API_SERVER_KEY: "hermes-key",
				}),
			),
		).not.toThrow();
		expect(() =>
			validateConfig(
				loadConfig({
					LINE_CHANNEL_SECRET: "line-secret",
					LINE_CHANNEL_ACCESS_TOKEN: "line-token",
					AGENT_RUNTIME: "hermes",
					HERMES_BASE_URL: "https://hermes.internal",
					HERMES_API_SERVER_KEY: "hermes-key",
				}),
			),
		).toThrow("Missing required environment variables: OPENAI_API_KEY");
	});

	test("keeps fallback mode owning both legacy and Hermes secrets", () => {
		expect(() =>
			validateConfig(
				loadConfig({
					LINE_CHANNEL_SECRET: "line-secret",
					LINE_CHANNEL_ACCESS_TOKEN: "line-token",
					OPENAI_API_KEY: "openai-key",
					GITHUB_TOKEN: "github-token",
					AGENT_RUNTIME: "fallback",
					HERMES_BASE_URL: "https://hermes.internal",
					HERMES_API_SERVER_KEY: "hermes-key",
				}),
			),
		).not.toThrow();
		expect(() =>
			validateConfig(
				loadConfig({
					LINE_CHANNEL_SECRET: "line-secret",
					LINE_CHANNEL_ACCESS_TOKEN: "line-token",
					OPENAI_API_KEY: "openai-key",
					GITHUB_TOKEN: "github-token",
					AGENT_RUNTIME: "fallback",
					HERMES_BASE_URL: "not a url",
					HERMES_API_SERVER_KEY: "hermes-key",
				}),
			),
		).toThrow("HERMES_BASE_URL must be a valid URL");
	});

	test("requires a valid matching schema catalog for the database adapter", () => {
		const databaseEnv = {
			...validEnv,
			DATABASE_ADAPTER_URL: "https://db-reader.example/query",
			DATABASE_ADAPTER_TOKEN: "token",
			DATABASE_DATASOURCE: "lms-readonly",
			DATABASE_ALLOWED_SCHEMAS: "public",
			DATABASE_ALLOWED_TABLES: "public.users",
			DATABASE_SCHEMA_CATALOG_JSON: JSON.stringify({
				datasource: "lms-readonly",
				tables: [
					{
						schema: "public",
						name: "users",
						columns: [{ name: "id" }],
					},
				],
			}),
		};
		expect(() => validateConfig(loadConfig(databaseEnv))).not.toThrow();
		expect(() =>
			validateConfig(
				loadConfig({ ...databaseEnv, DATABASE_SCHEMA_CATALOG_JSON: "" }),
			),
		).toThrow(
			"Incomplete database adapter configuration: DATABASE_SCHEMA_CATALOG_JSON",
		);
		expect(() =>
			validateConfig(
				loadConfig({
					...databaseEnv,
					DATABASE_SCHEMA_CATALOG_JSON: JSON.stringify({
						datasource: "wrong-datasource",
						tables: [
							{
								schema: "public",
								name: "users",
								columns: [{ name: "id" }],
							},
						],
					}),
				}),
			),
		).toThrow("datasource must match DATABASE_DATASOURCE");
	});
});
