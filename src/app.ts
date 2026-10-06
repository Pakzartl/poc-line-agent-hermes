import { createResponsesClient } from "./agent/llm-client";
import { createAgentOrchestrator } from "./agent/orchestrator";
import type { SkillManager } from "./agent/skill-manager";
import { createToolRunner } from "./agent/tool-runner";
import {
	type CapabilityJobStore,
	createMemoryCapabilityJobStore,
} from "./capabilities/job-store";
import type { AppConfig } from "./config";
import { createDatabaseReadClient, type DatabaseReadClient } from "./db/client";
import {
	type DatabasePlanningContext,
	parseDbSchemaCatalogJson,
} from "./db/nl-planner";
import { defaultMaskColumns } from "./db/query-policy";
import {
	type DiscordGatewayMessage,
	handleDiscordGatewayMessage,
} from "./discord/gateway-webhook";
import {
	createInlineDiscordJobQueue,
	type DiscordJobQueue,
} from "./discord/job";
import { createDiscordReplyClient } from "./discord/reply";
import { handleDiscordInteraction } from "./discord/webhook";
import { handleQueueFailureEvent } from "./events/queue-failure-handler";
import type { HermesClient } from "./hermes/client";
import {
	classifyIntent,
	type IntentRouterDecision,
} from "./intent-router/client";
import { createLineReplyClient } from "./line/reply";
import { handleLineWebhook } from "./line/webhook";
import type { SessionMemoryStore } from "./memory/types";
import { createTelegramCodeSourceClient } from "./telegram/code-source";
import {
	createInlineTelegramJobQueue,
	type TelegramJobQueue,
} from "./telegram/job";
import { createTelegramReplyClient } from "./telegram/reply";
import {
	createMemoryTelegramSourceSelectionStore,
	type TelegramSourceSelectionStore,
} from "./telegram/source-selection";
import {
	createPassThroughTelegramUpdateStore,
	type TelegramUpdateStore,
} from "./telegram/update-store";
import { handleTelegramWebhook } from "./telegram/webhook";
import { createGitHubTools } from "./tools/github";
import { createWhatsAppReplyClient } from "./whatsapp/reply";
import {
	handleWhatsAppVerification,
	handleWhatsAppWebhook,
} from "./whatsapp/webhook";

export type AppDeps = {
	classifyIntent?: (text: string) => Promise<IntentRouterDecision>;
	discordIntentQueue?: { send(message: DiscordGatewayMessage): Promise<void> };
	config: AppConfig;
	orchestrator: ReturnType<typeof createAgentOrchestrator>;
	lineReplyClient: ReturnType<typeof createLineReplyClient>;
	telegramReplyClient: ReturnType<typeof createTelegramReplyClient>;
	discordReplyClient: ReturnType<typeof createDiscordReplyClient>;
	hermesClient?: HermesClient;
	telegramJobQueue: TelegramJobQueue;
	discordJobQueue: DiscordJobQueue;
	telegramUpdateStore: TelegramUpdateStore;
	discordUpdateStore: TelegramUpdateStore;
	capabilityJobStore?: CapabilityJobStore;
	databaseReadClient?: DatabaseReadClient;
	databasePlanningContext?: DatabasePlanningContext;
	telegramSourceSelectionStore?: TelegramSourceSelectionStore;
	discordSourceSelectionStore?: TelegramSourceSelectionStore;
	telegramCodeSourceClient?: ReturnType<typeof createTelegramCodeSourceClient>;
	discordCodeSourceClient?: ReturnType<typeof createTelegramCodeSourceClient>;
	whatsAppReplyClient: ReturnType<typeof createWhatsAppReplyClient>;
	memoryStore: SessionMemoryStore;
};

export type AppDepsOptions = {
	discordIntentQueue?: { send(message: DiscordGatewayMessage): Promise<void> };
	fetch?: typeof fetch;
	memoryStore: SessionMemoryStore;
	skillManager: SkillManager;
	telegramJobQueue?: TelegramJobQueue;
	discordJobQueue?: DiscordJobQueue;
	telegramUpdateStore?: TelegramUpdateStore;
	telegramSourceSelectionStore?: TelegramSourceSelectionStore;
	capabilityJobStore?: CapabilityJobStore;
	hermesClient?: HermesClient;
};

export function createAppDeps(
	config: AppConfig,
	options: AppDepsOptions,
): AppDeps {
	const fetchImpl = options.fetch ?? fetch;
	const toolRunner = createToolRunner(
		createGitHubTools({ config: config.github, fetch: fetchImpl }),
	);
	const orchestrator = createAgentOrchestrator({
		skillManager: options.skillManager,
		responsesClient: createResponsesClient(config, fetchImpl),
		toolRunner,
		maxToolRounds: config.llm.maxToolRounds,
		maxToolCalls: config.llm.maxToolCalls,
	});
	const lineReplyClient = createLineReplyClient({
		channelAccessToken: config.line.channelAccessToken,
		apiBaseUrl: config.line.apiBaseUrl,
		fetch: fetchImpl,
	});
	const telegramReplyClient = createTelegramReplyClient({
		botToken: config.telegram.botToken,
		apiBaseUrl: config.telegram.apiBaseUrl,
		fetch: fetchImpl,
	});
	const discordReplyClient = createDiscordReplyClient({
		apiBaseUrl: config.discord.apiBaseUrl,
		fetch: fetchImpl,
		botToken: config.discord.botToken,
	});
	const telegramCodeSourceClient = createTelegramCodeSourceClient({
		config: config.github,
		fetch: fetchImpl,
	});
	const whatsAppReplyClient = createWhatsAppReplyClient({
		accessToken: config.whatsapp.accessToken,
		phoneNumberId: config.whatsapp.phoneNumberId,
		apiBaseUrl: config.whatsapp.apiBaseUrl,
		fetch: fetchImpl,
	});
	const sourceSelectionStore =
		options.telegramSourceSelectionStore ??
		createMemoryTelegramSourceSelectionStore();
	const capabilityJobStore =
		options.capabilityJobStore ?? createMemoryCapabilityJobStore();
	const databaseConfig = config.capabilities;
	const databaseConfigured = Boolean(
		databaseConfig?.databaseAdapterUrl &&
			databaseConfig.databaseAdapterToken &&
			databaseConfig.databaseDatasource &&
			databaseConfig.databaseAllowedSchemas.length > 0 &&
			databaseConfig.databaseAllowedTables.length > 0 &&
			databaseConfig.databaseSchemaCatalogJson,
	);
	const databaseCatalog = databaseConfigured
		? parseDbSchemaCatalogJson(databaseConfig?.databaseSchemaCatalogJson ?? "")
		: undefined;
	const databasePolicy =
		databaseConfigured && databaseConfig && databaseCatalog
			? {
					enabled: true,
					datasource: databaseConfig.databaseDatasource,
					allowedSchemas: databaseConfig.databaseAllowedSchemas,
					allowedTables: databaseConfig.databaseAllowedTables,
					maxRows: 200,
					maxBytes: 1_000_000,
					timeoutMs: 5_000,
					maskColumns: [
						...new Set([
							...defaultMaskColumns,
							...databaseCatalog.tables.flatMap((table) =>
								table.columns
									.filter((column) => column.sensitive)
									.map((column) => column.name),
							),
						]),
					],
				}
			: undefined;
	const databaseReadClient =
		databaseConfig && databasePolicy
			? createDatabaseReadClient({
					endpoint: databaseConfig.databaseAdapterUrl,
					token: databaseConfig.databaseAdapterToken,
					policy: databasePolicy,
					fetch: fetchImpl,
				})
			: undefined;
	const databasePlanningContext =
		databaseCatalog && databasePolicy
			? { catalog: databaseCatalog, policy: databasePolicy }
			: undefined;
	const routerConfig = config.intentRouter;
	const baseDeps = {
		...(routerConfig?.enabled
			? {
					classifyIntent: (text: string) =>
						classifyIntent(text, routerConfig, fetchImpl),
				}
			: {}),
		...(options.discordIntentQueue
			? { discordIntentQueue: options.discordIntentQueue }
			: {}),
		config,
		fetch: fetchImpl,
		orchestrator,
		lineReplyClient,
		telegramReplyClient,
		discordReplyClient,
		telegramUpdateStore:
			options.telegramUpdateStore ?? createPassThroughTelegramUpdateStore(),
		telegramSourceSelectionStore: sourceSelectionStore,
		discordSourceSelectionStore: sourceSelectionStore,
		telegramCodeSourceClient,
		discordCodeSourceClient: telegramCodeSourceClient,
		discordUpdateStore:
			options.telegramUpdateStore ?? createPassThroughTelegramUpdateStore(),
		capabilityJobStore,
		...(databaseReadClient ? { databaseReadClient } : {}),
		...(databasePlanningContext ? { databasePlanningContext } : {}),
		...(options.hermesClient ? { hermesClient: options.hermesClient } : {}),
		whatsAppReplyClient,
		memoryStore: options.memoryStore,
	};
	return {
		...baseDeps,
		telegramJobQueue:
			options.telegramJobQueue ?? createInlineTelegramJobQueue(baseDeps),
		discordJobQueue:
			options.discordJobQueue ?? createInlineDiscordJobQueue(baseDeps),
	};
}

export function createAppHandler(
	deps: AppDeps,
): (request: Request) => Promise<Response> {
	return async (request) => {
		const url = new URL(request.url);

		if (request.method === "GET" && url.pathname === "/") {
			return new Response(statusPage, {
				headers: {
					"Cache-Control": "no-store",
					"Content-Security-Policy":
						"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
					"Content-Type": "text/html; charset=utf-8",
					"X-Content-Type-Options": "nosniff",
				},
			});
		}
		if (request.method === "GET" && url.pathname === "/health") {
			return Response.json({ ok: true });
		}

		if (request.method === "POST" && url.pathname === "/events/queue-failure") {
			return handleQueueFailureEvent(request, {
				secret: deps.config.events?.queueFailureSecret ?? "",
				discordChannelId:
					deps.config.events?.queueFailureDiscordChannelId ?? "",
				discordReplyClient: deps.discordReplyClient,
				updateStore: deps.discordUpdateStore,
			});
		}

		if (request.method === "POST" && url.pathname === "/line/webhook") {
			if (!isLineConfigured(deps.config)) {
				return new Response("LINE provider is not configured", { status: 503 });
			}
			return handleLineWebhook(request, deps);
		}

		if (request.method === "POST" && url.pathname === "/telegram/webhook") {
			if (!isTelegramConfigured(deps.config)) {
				return new Response("Telegram provider is not configured", {
					status: 503,
				});
			}
			return handleTelegramWebhook(request, deps);
		}

		if (request.method === "POST" && url.pathname === "/discord/interactions") {
			if (!isDiscordConfigured(deps.config)) {
				return new Response("Discord provider is not configured", {
					status: 503,
				});
			}
			return handleDiscordInteraction(request, deps);
		}

		if (
			request.method === "POST" &&
			url.pathname === "/discord/gateway/messages"
		) {
			if (!isDiscordGatewayConfigured(deps.config)) {
				return new Response("Discord Gateway is not configured", {
					status: 503,
				});
			}
			if (!deps.discordSourceSelectionStore || !deps.discordCodeSourceClient) {
				return new Response("Discord Gateway dependencies are unavailable", {
					status: 503,
				});
			}
			return handleDiscordGatewayMessage(request, {
				...deps,
				discordSourceSelectionStore: deps.discordSourceSelectionStore,
				discordCodeSourceClient: deps.discordCodeSourceClient,
			});
		}

		if (url.pathname === "/whatsapp/webhook") {
			if (!isWhatsAppConfigured(deps.config)) {
				return new Response("WhatsApp provider is not configured", {
					status: 503,
				});
			}
			if (request.method === "GET") {
				return handleWhatsAppVerification(request, deps.config);
			}
			if (request.method === "POST") {
				return handleWhatsAppWebhook(request, deps);
			}
		}

		return new Response("not found", { status: 404 });
	};
}

const statusPage = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Messaging Agent</title>
  <style>
    :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b1220; color: #e5eefc; }
    main { width: min(560px, calc(100% - 48px)); padding: 32px; border: 1px solid #24324a; border-radius: 18px; background: #111b2d; box-shadow: 0 20px 60px #0006; }
    h1 { margin: 0 0 10px; font-size: 28px; }
    p { color: #9fb0c9; line-height: 1.6; }
    .status { display: inline-flex; gap: 8px; align-items: center; color: #86efac; font-weight: 700; }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: #22c55e; box-shadow: 0 0 18px #22c55e; }
    code { color: #bfdbfe; }
  </style>
</head>
<body>
  <main>
    <div class="status"><span class="dot"></span>Operational</div>
    <h1>Messaging Agent</h1>
    <p>The Cloudflare Worker is running. Provider webhooks are authenticated and Telegram/Discord agent access is restricted by user ID.</p>
    <p>Health check: <code>/health</code></p>
  </main>
</body>
</html>`;

function isLineConfigured(config: AppConfig): boolean {
	return Boolean(config.line.channelSecret && config.line.channelAccessToken);
}

function isTelegramConfigured(config: AppConfig): boolean {
	return Boolean(config.telegram.botToken && config.telegram.webhookSecret);
}

function isDiscordConfigured(config: AppConfig): boolean {
	return Boolean(
		config.discord.applicationId &&
			config.discord.publicKey &&
			config.discord.allowedUserIds.length > 0,
	);
}

function isDiscordGatewayConfigured(config: AppConfig): boolean {
	return Boolean(
		isDiscordConfigured(config) &&
			config.discord.botToken &&
			config.discord.gatewaySharedSecret &&
			config.discord.allowedGuildIds.length > 0,
	);
}

function isWhatsAppConfigured(config: AppConfig): boolean {
	return Boolean(
		config.whatsapp.accessToken &&
			config.whatsapp.phoneNumberId &&
			config.whatsapp.verifyToken &&
			config.whatsapp.appSecret,
	);
}
