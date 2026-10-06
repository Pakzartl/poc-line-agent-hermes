import { createSkillManager, type SkillName } from "./agent/skill-manager";
import { createAppDeps, createAppHandler } from "./app";
import { createDurableObjectCapabilityJobStore } from "./capabilities/job-store";
import { loadConfig, validateConfig } from "./config";
import { processDiscordQueueMessage, type DiscordJob } from "./discord/job";
import {
	processQueueFailureDlqMessage,
	queueFailureDlqName,
} from "./events/queue-failure-dlq";
import { createKvSessionMemoryStore } from "./memory/kv-session-memory";
import apiCatalogSkill from "./skills/api-catalog.md";
import architectureMapSkill from "./skills/architecture-map.md";
import bugInvestigatorSkill from "./skills/bug-investigator.md";
import commitReviewSkill from "./skills/commit-review.md";
import configExplainerSkill from "./skills/config-explainer.md";
import databaseMapSkill from "./skills/database-map.md";
import deploySkill from "./skills/deploy.md";
import dependencyCheckSkill from "./skills/dependency-check.md";
import explainCodeSkill from "./skills/explain-code.md";
import findCodeSkill from "./skills/find-code.md";
import codeScanSkill from "./skills/code-scan.md";
import incidentTriageSkill from "./skills/incident-triage.md";
import missingTestsSkill from "./skills/missing-tests.md";
import onboardingGuideSkill from "./skills/onboarding-guide.md";
import prReviewSkill from "./skills/pr-review.md";
import recentChangesSkill from "./skills/recent-changes.md";
import releaseSummarySkill from "./skills/release-summary.md";
import repoComparisonSkill from "./skills/repo-comparison.md";
import repoOverviewSkill from "./skills/repo-overview.md";
import riskAssessmentSkill from "./skills/risk-assessment.md";
import securityReviewSkill from "./skills/security-review.md";
import testFinderSkill from "./skills/test-finder.md";
import traceFeatureSkill from "./skills/trace-feature.md";
import { processTelegramQueueMessage, type TelegramJob } from "./telegram/job";
import { TelegramSessionCoordinator } from "./telegram/session-coordinator";
import { createDurableObjectTelegramSourceSelectionStore } from "./telegram/source-selection";
import { createDurableObjectTelegramUpdateStore } from "./telegram/update-store";
import { createHermesClient } from "./hermes/client";

const skillDocuments: Readonly<Record<SkillName, string>> = {
	"repo-overview": repoOverviewSkill,
	"find-code": findCodeSkill,
	"code-scan": codeScanSkill,
	"explain-code": explainCodeSkill,
	"trace-feature": traceFeatureSkill,
	"recent-changes": recentChangesSkill,
	"commit-review": commitReviewSkill,
	"pr-review": prReviewSkill,
	"bug-investigator": bugInvestigatorSkill,
	"test-finder": testFinderSkill,
	"missing-tests": missingTestsSkill,
	"dependency-check": dependencyCheckSkill,
	"security-review": securityReviewSkill,
	"config-explainer": configExplainerSkill,
	"api-catalog": apiCatalogSkill,
	"database-map": databaseMapSkill,
	"architecture-map": architectureMapSkill,
	"onboarding-guide": onboardingGuideSkill,
	"release-summary": releaseSummarySkill,
	"incident-triage": incidentTriageSkill,
	"repo-comparison": repoComparisonSkill,
	"risk-assessment": riskAssessmentSkill,
	deploy: deploySkill,
};

export default {
	async fetch(request, env): Promise<Response> {
		try {
			const handler = createAppHandler(createWorkerDeps(env));

			return await handler(request);
		} catch (error) {
			console.error(
				JSON.stringify({
					message: "worker request failed",
					path: new URL(request.url).pathname,
					error: error instanceof Error ? error.message : "Unknown error",
				}),
			);
			return Response.json({ error: "Internal server error" }, { status: 500 });
		}
	},
	async queue(batch, env): Promise<void> {
		const deps = createWorkerDeps(env);
		if (batch.queue === queueFailureDlqName) {
			for (const message of batch.messages) {
				await processQueueFailureDlqMessage({
					messageId: message.id,
					body: message.body,
					attempts: message.attempts,
					deps: {
						discordChannelId:
							deps.config.events?.queueFailureDiscordChannelId ?? "",
						discordReplyClient: deps.discordReplyClient,
						updateStore: deps.discordUpdateStore,
					},
				});
				message.ack();
			}
			return;
		}
		for (const message of batch.messages) {
			if (isDiscordQueueEnvelope(message.body)) {
				await processDiscordQueueMessage(
					{
						body: message.body.job,
						attempts: message.attempts,
						ack: () => message.ack(),
						retry: (options) => message.retry(options),
					},
					deps,
				);
				continue;
			}
			await processTelegramQueueMessage(
				{
					body: message.body,
					attempts: message.attempts,
					ack: () => message.ack(),
					retry: (options) => message.retry(options),
				},
				deps,
			);
		}
	},
} satisfies ExportedHandler<Env, WorkerQueueMessage>;

export { TelegramSessionCoordinator };

function createWorkerDeps(env: Env) {
	const config = loadConfig(createConfigEnvironment(env));
	validateConfig(config);
	return createAppDeps(config, {
		memoryStore: createKvSessionMemoryStore(
			env.SESSION_MEMORY,
			config.memory.maxMessages,
		),
		telegramJobQueue: {
			send: async (job) => {
				await env.TELEGRAM_JOBS.send(job);
			},
		},
		discordJobQueue: {
			send: async (job) => {
				await env.TELEGRAM_JOBS.send({ provider: "discord", job });
			},
		},
		telegramUpdateStore: createDurableObjectTelegramUpdateStore(
			env.TELEGRAM_SESSION_COORDINATOR,
		),
		telegramSourceSelectionStore:
			createDurableObjectTelegramSourceSelectionStore(
				env.TELEGRAM_SESSION_COORDINATOR,
			),
		capabilityJobStore: createDurableObjectCapabilityJobStore({
			namespace: env.TELEGRAM_SESSION_COORDINATOR,
			scopeName: "discord-capabilities-v1",
		}),
		...(config.runtime.mode === "legacy"
			? {}
			: {
					hermesClient: createHermesClient({
						baseUrl: config.hermes.baseUrl,
						apiServerKey: config.hermes.apiServerKey,
					}),
				}),
		skillManager: createSkillManager(async (name) => skillDocuments[name]),
	});
}

function createConfigEnvironment(env: Env): Record<string, string | undefined> {
	return {
		AGENT_RUNTIME: env.AGENT_RUNTIME,
		LINE_CHANNEL_SECRET: env.LINE_CHANNEL_SECRET,
		LINE_CHANNEL_ACCESS_TOKEN: env.LINE_CHANNEL_ACCESS_TOKEN,
		LINE_API_BASE_URL: env.LINE_API_BASE_URL,
		TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN,
		TELEGRAM_WEBHOOK_SECRET: env.TELEGRAM_WEBHOOK_SECRET,
		TELEGRAM_ALLOWED_USER_IDS: env.TELEGRAM_ALLOWED_USER_IDS,
		TELEGRAM_API_BASE_URL: env.TELEGRAM_API_BASE_URL,
		DISCORD_APPLICATION_ID: env.DISCORD_APPLICATION_ID,
		DISCORD_PUBLIC_KEY: env.DISCORD_PUBLIC_KEY,
		DISCORD_BOT_TOKEN: env.DISCORD_BOT_TOKEN,
		DISCORD_GATEWAY_SHARED_SECRET: env.DISCORD_GATEWAY_SHARED_SECRET,
		DISCORD_ALLOWED_USER_IDS: env.DISCORD_ALLOWED_USER_IDS,
		DISCORD_ALLOWED_GUILD_IDS: env.DISCORD_ALLOWED_GUILD_IDS,
		DISCORD_API_BASE_URL: env.DISCORD_API_BASE_URL,
		WHATSAPP_ACCESS_TOKEN: env.WHATSAPP_ACCESS_TOKEN,
		WHATSAPP_PHONE_NUMBER_ID: env.WHATSAPP_PHONE_NUMBER_ID,
		WHATSAPP_VERIFY_TOKEN: env.WHATSAPP_VERIFY_TOKEN,
		WHATSAPP_APP_SECRET: env.WHATSAPP_APP_SECRET,
		WHATSAPP_API_BASE_URL: env.WHATSAPP_API_BASE_URL,
		OPENAI_API_KEY: env.OPENAI_API_KEY,
		OPENAI_BASE_URL: env.OPENAI_BASE_URL,
		OPENAI_MODEL: env.OPENAI_MODEL,
		OPENAI_MAX_TOOL_ROUNDS: env.OPENAI_MAX_TOOL_ROUNDS,
		OPENAI_MAX_TOOL_CALLS: env.OPENAI_MAX_TOOL_CALLS,
		GITHUB_TOKEN: env.GITHUB_TOKEN,
		GITHUB_API_BASE_URL: env.GITHUB_API_BASE_URL,
		GITHUB_REF: env.GITHUB_REF,
		SESSION_MEMORY_MAX_MESSAGES: env.SESSION_MEMORY_MAX_MESSAGES,
		HERMES_BASE_URL: env.HERMES_BASE_URL,
		HERMES_API_SERVER_KEY: env.HERMES_API_SERVER_KEY,
		HERMES_TELEGRAM_ALLOWED_USER_IDS: env.HERMES_TELEGRAM_ALLOWED_USER_IDS,
		QUEUE_FAILURE_EVENT_SECRET: env.QUEUE_FAILURE_EVENT_SECRET,
		QUEUE_FAILURE_DISCORD_CHANNEL_ID: env.QUEUE_FAILURE_DISCORD_CHANNEL_ID,
		DATABASE_ADAPTER_URL: env.DATABASE_ADAPTER_URL,
		DATABASE_ADAPTER_TOKEN: env.DATABASE_ADAPTER_TOKEN,
		DATABASE_DATASOURCE: env.DATABASE_DATASOURCE,
		DATABASE_ALLOWED_SCHEMAS: env.DATABASE_ALLOWED_SCHEMAS,
		DATABASE_ALLOWED_TABLES: env.DATABASE_ALLOWED_TABLES,
		DATABASE_SCHEMA_CATALOG_JSON: env.DATABASE_SCHEMA_CATALOG_JSON,
		ARTIFACT_RENDERER_URL: env.ARTIFACT_RENDERER_URL,
		ARTIFACT_RENDERER_TOKEN: env.ARTIFACT_RENDERER_TOKEN,
		ARTIFACT_SCREENSHOT_TARGETS_JSON: env.ARTIFACT_SCREENSHOT_TARGETS_JSON,
		DEPLOY_TARGETS_JSON: env.DEPLOY_TARGETS_JSON,
		DEPLOY_EXECUTOR_TOKEN: env.DEPLOY_EXECUTOR_TOKEN,
	};
}

type DiscordQueueEnvelope = {
	provider: "discord";
	job: DiscordJob;
};

type WorkerQueueMessage = TelegramJob | DiscordQueueEnvelope;

function isDiscordQueueEnvelope(
	message: WorkerQueueMessage,
): message is DiscordQueueEnvelope {
	return "provider" in message && message.provider === "discord";
}
