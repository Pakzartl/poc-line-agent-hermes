import { describe, expect, test } from "bun:test";
import { createMemoryCapabilityJobStore } from "../capabilities/job-store";
import { loadConfig } from "../config";
import {
	planNaturalLanguageDatabaseQuery,
	type DatabasePlanningContext,
} from "../db/nl-planner";
import { createDeployPlan } from "../deploy/plan";
import type { SessionMemoryStore } from "../memory/types";
import { createPassThroughTelegramUpdateStore } from "../telegram/update-store";
import { type DiscordJob, processDiscordQueueMessage } from "./job";

describe("Discord queued jobs", () => {
	test("runs Hermes and edits the deferred interaction response", async () => {
		const hermesInputs: unknown[] = [];
		const replies: unknown[][] = [];
		let acked = false;
		const job = discordJob();

		await processDiscordQueueMessage(
			{
				body: job,
				attempts: 1,
				ack: () => {
					acked = true;
				},
				retry: () => undefined,
			},
			{
				config: loadConfig({
					AGENT_RUNTIME: "hermes",
					HERMES_BASE_URL: "https://hermes.example",
					HERMES_API_SERVER_KEY: "key",
				}),
				orchestrator: { answer: async () => "legacy" },
				hermesClient: {
					chat: async (input) => {
						hermesInputs.push(input);
						return { text: "Hermes answer" };
					},
					listMessages: async () => [],
					lastMessageMarker: async () => undefined,
					clearSession: async () => undefined,
				},
				discordReplyClient: {
					reply: async (...args) => {
						replies.push(args);
					},
					replyToChannel: async () => undefined,
					sendTyping: async () => undefined,
				},
				discordUpdateStore: createPassThroughTelegramUpdateStore(),
				memoryStore: {
					read: async () => [],
					append: async (_sessionId, messages) => messages,
					clear: async () => undefined,
				},
			},
		);

		expect(hermesInputs).toEqual([
			{
				sessionId: "discord:channel:source-v1:guild:channel:user",
				source: "discord",
				input:
					'POC_SOURCE_SCOPE_V1 {"repository":"codemonday-dev/lms-backend","branch":"dev"}\n\nfind the rate limit',
			},
		]);
		expect(replies).toHaveLength(1);
		expect(replies[0]?.slice(0, 3)).toEqual(["app", "token", "Hermes answer"]);
		const replyOptions = replies[0]?.[3] as {
			attachment?: { filename: string; data: string };
		};
		expect(replyOptions.attachment?.filename).toStartWith(
			"ask-code-code-investigation-codemonday-dev-lms-backend-dev-",
		);
		expect(replyOptions.attachment?.data).toContain(
			"# Code Investigation: codemonday-dev/lms-backend@dev",
		);
		expect(replyOptions.attachment?.data).toContain("- Capability: ask-code");
		expect(acked).toBe(true);
	});

	test("keeps typing during natural channel delivery and replies to the source message", async () => {
		const channelReplies: unknown[][] = [];
		const typing: string[] = [];
		let acked = false;
		await processDiscordQueueMessage(
			{
				body: {
					...discordJob(),
					interactionToken: undefined,
					interactionId: "message",
					delivery: "channel",
					sourceMessageId: "message",
					idempotencyKey: "discord:message:message",
				},
				attempts: 1,
				ack: () => {
					acked = true;
				},
				retry: () => undefined,
			},
			{
				config: loadConfig({
					AGENT_RUNTIME: "hermes",
					HERMES_BASE_URL: "https://hermes.example",
					HERMES_API_SERVER_KEY: "key",
				}),
				orchestrator: { answer: async () => "legacy" },
				hermesClient: {
					chat: async () => ({ text: "Hermes answer" }),
					listMessages: async () => [],
					lastMessageMarker: async () => undefined,
					clearSession: async () => undefined,
				},
				discordReplyClient: {
					reply: async () => undefined,
					replyToChannel: async (...args) => {
						channelReplies.push(args);
					},
					sendTyping: async (channelId) => {
						typing.push(channelId);
					},
				},
				discordUpdateStore: createPassThroughTelegramUpdateStore(),
				memoryStore: {
					read: async () => [],
					append: async (_sessionId, messages) => messages,
					clear: async () => undefined,
				},
			},
		);

		expect(typing).toEqual(["channel"]);
		expect(channelReplies).toHaveLength(1);
		expect(channelReplies[0]?.slice(0, 3)).toEqual([
			"channel",
			"Hermes answer",
			"message",
		]);
		const channelOptions = channelReplies[0]?.[3] as {
			attachment?: { filename: string; data: string };
		};
		expect(channelOptions.attachment?.data).toContain(
			"- Input delivery: channel",
		);
		expect(acked).toBe(true);
	});

	test("adds risk assessment instructions and artifact metadata", async () => {
		const hermesInputs: unknown[] = [];
		const replies: unknown[][] = [];

		await processDiscordQueueMessage(
			{
				body: {
					...discordJob(),
					capability: {
						kind: "risk_assessment",
						repository: "codemonday-dev/lms-backend",
						branch: "dev",
						change: "assess checkout deploy",
						baseRef: "main",
					},
					question: "assess checkout deploy",
				},
				attempts: 1,
				ack: () => undefined,
				retry: () => undefined,
			},
			{
				config: loadConfig({
					AGENT_RUNTIME: "hermes",
					HERMES_BASE_URL: "https://hermes.example",
					HERMES_API_SERVER_KEY: "key",
				}),
				orchestrator: { answer: async () => "legacy" },
				hermesClient: {
					chat: async (input) => {
						hermesInputs.push(input);
						return {
							text: `## Summary
Checkout risk.
## Blast Radius
- Learner checkout route
## Evidence
- \`apps/learner-gateway/src/checkout.ts:42\`
## Risks
- [high] Checkout failure: users may not complete payment.
## Human Test Plan
- Run checkout success and failure paths.
## Evidence Gaps
- Production payment configuration is external.
## Recommended Action
Approve after checkout tests pass.`,
						};
					},
					listMessages: async () => [],
					lastMessageMarker: async () => undefined,
					clearSession: async () => undefined,
				},
				discordReplyClient: {
					reply: async (...args) => {
						replies.push(args);
					},
					replyToChannel: async () => undefined,
					sendTyping: async () => undefined,
				},
				discordUpdateStore: createPassThroughTelegramUpdateStore(),
				memoryStore: {
					read: async () => [],
					append: async (_sessionId, messages) => messages,
					clear: async () => undefined,
				},
			},
		);

		expect(JSON.stringify(hermesInputs[0])).toContain("## Blast Radius");
		expect(JSON.stringify(hermesInputs[0])).toContain(
			"compare_refs with base main and head dev",
		);
		const replyOptions = replies[0]?.[3] as {
			attachment?: { filename: string; data: string };
		};
		expect(replyOptions.attachment?.filename).toStartWith(
			"risk-assessment-risk-assessment-codemonday-dev-lms-backend-dev-",
		);
		expect(replyOptions.attachment?.data).toContain(
			"- Capability: risk-assessment",
		);
		expect(replyOptions.attachment?.data).toContain(
			"apps/learner-gateway/src/checkout.ts:42",
		);
		expect(replyOptions.attachment?.data).toContain("Checkout failure");
		expect(replyOptions.attachment?.data).toContain(
			"Run checkout success and failure paths.",
		);
	});

	test("returns a deploy plan with approval buttons without executing it", async () => {
		const replies: unknown[][] = [];
		let executorCalls = 0;
		const store = createMemoryCapabilityJobStore();
		const targets = [
			{
				id: "worker-prod",
				displayName: "Worker production",
				environment: "production" as const,
				allowedRepositories: ["codemonday-dev/lms-backend"],
				executorUrl: "https://deploy.example/run",
				requiresApproval: true as const,
			},
		];
		const deployPlan = await createDeployPlan(
			{
				targetId: "worker-prod",
				repository: "codemonday-dev/lms-backend",
				commitSha: "a".repeat(40),
				requestedBy: "user",
			},
			targets,
		);

		await processDiscordQueueMessage(
			{
				body: {
					...discordJob(),
					branch: deployPlan.commitSha,
					question: "production deploy",
					deployPlan,
					canonicalInputHash: deployPlan.digest,
					capability: {
						kind: "deploy_request",
						repository: deployPlan.repository,
						commitSha: deployPlan.commitSha,
						target: deployPlan.targetId,
					},
				},
				attempts: 1,
				ack: () => undefined,
				retry: () => undefined,
			},
			{
				config: loadConfig({
					AGENT_RUNTIME: "hermes",
					HERMES_BASE_URL: "https://hermes.example",
					HERMES_API_SERVER_KEY: "key",
					DEPLOY_TARGETS_JSON: JSON.stringify(targets),
					DEPLOY_EXECUTOR_TOKEN: "executor-token",
				}),
				orchestrator: { answer: async () => "legacy" },
				hermesClient: {
					chat: async () => ({ text: "Deployment plan only" }),
					listMessages: async () => [],
					lastMessageMarker: async () => undefined,
					clearSession: async () => undefined,
				},
				discordReplyClient: {
					reply: async (...args) => {
						replies.push(args);
					},
					replyToChannel: async () => undefined,
					sendTyping: async () => undefined,
				},
				discordUpdateStore: createPassThroughTelegramUpdateStore(),
				capabilityJobStore: store,
				memoryStore: memoryStore(),
				fetch: async () => {
					executorCalls += 1;
					return Response.json({ executionId: "should-not-run" });
				},
			},
		);

		expect(executorCalls).toBe(0);
		const options = replies[0]?.[3] as {
			components?: Array<{ components: Array<{ custom_id: string }> }>;
		};
		expect(
			options.components?.[0]?.components.map((item) => item.custom_id),
		).toEqual([
			`cap:approve:approval_${deployPlan.id}`,
			`cap:reject:approval_${deployPlan.id}`,
		]);
		expect((await store.getJob("interaction"))?.status).toBe(
			"waiting_approval",
		);
	});

	test("executes only a server-approved deploy plan and completes the original job", async () => {
		const replies: unknown[][] = [];
		const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
		const store = createMemoryCapabilityJobStore();
		const targets = [
			{
				id: "worker-prod",
				displayName: "Worker production",
				environment: "production" as const,
				allowedRepositories: ["codemonday-dev/lms-backend"],
				executorUrl: "https://deploy.example/run",
				requiresApproval: true as const,
			},
		];
		const deployPlan = await createDeployPlan(
			{
				targetId: "worker-prod",
				repository: "codemonday-dev/lms-backend",
				commitSha: "b".repeat(40),
				requestedBy: "user",
			},
			targets,
		);
		await store.createJob({
			jobId: "original-request",
			capability: "deploy_request",
			userId: "user",
			guildId: "guild",
			actionDigest: deployPlan.digest,
			objective: "deploy",
			metadata: { deployPlan: JSON.stringify(deployPlan) },
		});
		await store.transitionJob({
			jobId: "original-request",
			from: "queued",
			to: "running",
		});
		await store.requestApproval({
			approvalId: "approval_original-request",
			jobId: "original-request",
			userId: "user",
			guildId: "guild",
			action: "deploy",
			actionDigest: deployPlan.digest,
		});
		await store.decideApproval({
			approvalId: "approval_original-request",
			decision: "approved",
			userId: "user",
			guildId: "guild",
			actionDigest: deployPlan.digest,
		});

		await processDiscordQueueMessage(
			{
				body: {
					...discordJob(),
					interactionId: "approval-interaction",
					action: "deploy_execute",
					capabilityJobId: "original-request",
					deployPlan,
					deployApprovalId: "approval_original-request",
					approvedBy: "user",
					canonicalInputHash: deployPlan.digest,
					capability: {
						kind: "deploy_request",
						repository: deployPlan.repository,
						commitSha: deployPlan.commitSha,
						target: deployPlan.targetId,
					},
				},
				attempts: 1,
				ack: () => undefined,
				retry: () => undefined,
			},
			{
				config: loadConfig({
					DEPLOY_TARGETS_JSON: JSON.stringify(targets),
					DEPLOY_EXECUTOR_TOKEN: "executor-token",
				}),
				orchestrator: { answer: async () => "must not run" },
				discordReplyClient: {
					reply: async (...args) => {
						replies.push(args);
					},
					replyToChannel: async () => undefined,
					sendTyping: async () => undefined,
				},
				discordUpdateStore: createPassThroughTelegramUpdateStore(),
				capabilityJobStore: store,
				memoryStore: memoryStore(),
				fetch: async (input, init) => {
					requests.push({
						url: String(input),
						body: JSON.parse(String(init?.body)),
					});
					return Response.json({
						executionId: "exec-1",
						replayed: false,
						artifact: { id: "exec-1", status: "succeeded" },
						statusUrl: "https://deploy.example/status/exec-1",
					});
				},
			},
		);

		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({
			url: "https://deploy.example/run",
			body: {
				digest: deployPlan.digest,
				commitSha: "b".repeat(40),
				approvedBy: "user",
			},
		});
		expect(replies[0]?.[2]).toContain("exec-1");
		const options = replies[0]?.[3] as {
			attachment?: { data: string };
		};
		expect(options.attachment?.data).toContain(
			`"planDigest": "${deployPlan.digest}"`,
		);
		expect(options.attachment?.data).toContain('"approvedBy": "user"');
		expect(options.attachment?.data).toContain(
			'"rollbackRequiresSeparateApproval": true',
		);
		expect((await store.getJob("original-request"))?.status).toBe("completed");
	});

	test("captures only an allowlisted artifact target", async () => {
		const replies: unknown[][] = [];
		await processDiscordQueueMessage(
			{
				body: {
					...discordJob(),
					repository: undefined,
					branch: undefined,
					question: "capture the learner page",
					capability: {
						kind: "artifact_request",
						artifactKind: "screenshot",
						request: "capture the learner page",
						targetId: "learner-preview",
					},
				},
				attempts: 1,
				ack: () => undefined,
				retry: () => undefined,
			},
			{
				config: loadConfig({
					ARTIFACT_RENDERER_URL: "https://renderer.example/capture",
					ARTIFACT_RENDERER_TOKEN: "renderer-token",
					ARTIFACT_SCREENSHOT_TARGETS_JSON: JSON.stringify([
						{ id: "learner-preview", url: "https://learner.example" },
					]),
				}),
				orchestrator: { answer: async () => "must not run" },
				discordReplyClient: {
					reply: async (...args) => {
						replies.push(args);
					},
					replyToChannel: async () => undefined,
					sendTyping: async () => undefined,
				},
				discordUpdateStore: createPassThroughTelegramUpdateStore(),
				memoryStore: memoryStore(),
				fetch: async (_input, init) => {
					expect(JSON.parse(String(init?.body))).toEqual({
						targetId: "learner-preview",
					});
					return new Response(new Uint8Array([137, 80, 78, 71]), {
						headers: { "Content-Type": "image/png" },
					});
				},
			},
		);

		const options = replies[0]?.[3] as {
			attachment?: { filename: string; contentType: string; data: Uint8Array };
		};
		expect(options.attachment?.filename).toEndWith(".png");
		expect(options.attachment?.contentType).toBe("image/png");
	});

	test("generates a validated CSV artifact through the model-only path", async () => {
		const replies: unknown[][] = [];
		await processDiscordQueueMessage(
			{
				body: {
					...discordJob(),
					repository: undefined,
					branch: undefined,
					question: "summarize the release checks",
					capability: {
						kind: "artifact_request",
						artifactKind: "csv",
						request: "summarize the release checks",
					},
				},
				attempts: 1,
				ack: () => undefined,
				retry: () => undefined,
			},
			{
				config: loadConfig({}),
				orchestrator: {
					answer: async () =>
						JSON.stringify([{ check: "smoke", status: "pass" }]),
				},
				discordReplyClient: {
					reply: async (...args) => {
						replies.push(args);
					},
					replyToChannel: async () => undefined,
					sendTyping: async () => undefined,
				},
				discordUpdateStore: createPassThroughTelegramUpdateStore(),
				memoryStore: memoryStore(),
			},
		);

		const options = replies[0]?.[3] as {
			attachment?: { filename: string; contentType: string; data: Uint8Array };
		};
		expect(options.attachment?.filename).toEndWith(".csv");
		expect(options.attachment?.contentType).toContain("text/csv");
		expect(
			new TextDecoder().decode(options.attachment?.data ?? new Uint8Array()),
		).toBe("check,status\nsmoke,pass");
	});

	test("fails closed instead of sending an ungrounded DB question to Hermes", async () => {
		let hermesCalls = 0;
		const replies: unknown[][] = [];
		await processDiscordQueueMessage(
			{
				body: {
					...discordJob(),
					repository: undefined,
					branch: undefined,
					question: "how many learners are active?",
					capability: {
						kind: "database_query",
						question: "how many learners are active?",
					},
				},
				attempts: 1,
				ack: () => undefined,
				retry: () => undefined,
			},
			{
				config: loadConfig({
					AGENT_RUNTIME: "hermes",
					HERMES_BASE_URL: "https://hermes.example",
					HERMES_API_SERVER_KEY: "key",
				}),
				orchestrator: { answer: async () => "must not run" },
				hermesClient: {
					chat: async () => {
						hermesCalls += 1;
						return { text: "ungrounded" };
					},
					listMessages: async () => [],
					lastMessageMarker: async () => undefined,
					clearSession: async () => undefined,
				},
				discordReplyClient: {
					reply: async (...args) => {
						replies.push(args);
					},
					replyToChannel: async () => undefined,
					sendTyping: async () => undefined,
				},
				discordUpdateStore: createPassThroughTelegramUpdateStore(),
				memoryStore: memoryStore(),
			},
		);

		expect(hermesCalls).toBe(0);
		expect(replies[0]?.[2]).toContain("database planning is unavailable");
	});

	test("returns a database plan with approval buttons without executing it", async () => {
		const replies: unknown[][] = [];
		let queryCalls = 0;
		const store = createMemoryCapabilityJobStore();
		const databasePlan = await createDatabasePlan("db-plan", "user");

		await processDiscordQueueMessage(
			{
				body: {
					...discordJob(),
					interactionId: "db-plan",
					repository: undefined,
					branch: undefined,
					question: databasePlan.question,
					databasePlan,
					canonicalInputHash: databasePlan.planDigest,
					capability: {
						kind: "database_query",
						question: databasePlan.question,
					},
				},
				attempts: 1,
				ack: () => undefined,
				retry: () => undefined,
			},
			{
				config: loadConfig({}),
				orchestrator: { answer: async () => "must not run" },
				databaseReadClient: {
					query: async () => {
						queryCalls += 1;
						throw new Error("query must wait for approval");
					},
				},
				databasePlanningContext,
				discordReplyClient: {
					reply: async (...args) => {
						replies.push(args);
					},
					replyToChannel: async () => undefined,
					sendTyping: async () => undefined,
				},
				discordUpdateStore: createPassThroughTelegramUpdateStore(),
				capabilityJobStore: store,
				memoryStore: memoryStore(),
			},
		);

		expect(queryCalls).toBe(0);
		expect(replies[0]?.[2]).toContain("database query proposal");
		expect(replies[0]?.[2]).toContain(databasePlan.sql);
		const options = replies[0]?.[3] as {
			components?: Array<{ components: Array<{ custom_id: string }> }>;
		};
		expect(
			options.components?.[0]?.components.map((item) => item.custom_id),
		).toEqual([
			"cap:approve:approval_db_db-plan",
			"cap:reject:approval_db_db-plan",
		]);
		expect((await store.getJob("db-plan"))?.status).toBe("waiting_approval");
	});

	test("returns a provenance-rich JSON artifact for an approved DB read", async () => {
		const replies: unknown[][] = [];
		const calls: unknown[] = [];
		const store = createMemoryCapabilityJobStore();
		const databasePlan = await createDatabasePlan("db-job", "user");
		await store.createJob({
			jobId: "db-job",
			capability: "database_query",
			userId: "user",
			guildId: "guild",
			actionDigest: databasePlan.planDigest,
			objective: databasePlan.question,
			metadata: { databasePlan: JSON.stringify(databasePlan) },
		});
		await store.transitionJob({
			jobId: "db-job",
			from: "queued",
			to: "running",
		});
		await store.requestApproval({
			approvalId: "approval_db_db-job",
			jobId: "db-job",
			userId: "user",
			guildId: "guild",
			action: "run database query",
			actionDigest: databasePlan.planDigest,
		});
		await store.decideApproval({
			approvalId: "approval_db_db-job",
			decision: "approved",
			userId: "user",
			guildId: "guild",
			actionDigest: databasePlan.planDigest,
		});
		await processDiscordQueueMessage(
			{
				body: {
					...discordJob(),
					interactionId: "db-approval-interaction",
					action: "db_execute",
					capabilityJobId: "db-job",
					repository: undefined,
					branch: undefined,
					question: databasePlan.question,
					databasePlan,
					databaseApprovalId: "approval_db_db-job",
					approvedBy: "user",
					canonicalInputHash: databasePlan.planDigest,
					capability: {
						kind: "database_query",
						question: databasePlan.question,
					},
				},
				attempts: 1,
				ack: () => undefined,
				retry: () => undefined,
			},
			{
				config: loadConfig({}),
				orchestrator: { answer: async () => "must not run" },
				databaseReadClient: {
					query: async (input) => {
						calls.push(input);
						return {
							datasource: "lms-readonly",
							sql: databasePlan.sql,
							columns: ["id", "email"],
							rows: [{ id: 1, email: "[masked]" }],
							rowCount: 1,
							truncated: false,
							durationMs: 17,
							audit: {
								datasource: "lms-readonly",
								fingerprint: "q_12345678",
								statementKind: "select",
								referencedTables: ["public.users"],
								parameterCount: 0,
								limits: {
									maxRows: 100,
									maxBytes: 250_000,
									timeoutMs: 5_000,
								},
							},
						};
					},
				},
				databasePlanningContext,
				discordReplyClient: {
					reply: async (...args) => {
						replies.push(args);
					},
					replyToChannel: async () => undefined,
					sendTyping: async () => undefined,
				},
				discordUpdateStore: createPassThroughTelegramUpdateStore(),
				capabilityJobStore: store,
				memoryStore: memoryStore(),
			},
		);

		expect(replies[0]?.[2]).toContain("Datasource: `lms-readonly`");
		expect(replies[0]?.[2]).toContain("Duration: 17 ms");
		expect(calls).toEqual([
			{
				sql: databasePlan.sql,
				params: databasePlan.params,
				requestId: "db-job",
				requestedBy: "user",
			},
		]);
		const options = replies[0]?.[3] as {
			attachment?: { filename: string; contentType: string; data: string };
		};
		expect(options.attachment?.filename).toEndWith(".json");
		expect(options.attachment?.contentType).toContain("application/json");
		expect(options.attachment?.data).toContain(
			'"artifactId": "artifact_db-approval-interaction"',
		);
		expect(options.attachment?.data).toContain(
			`"sql": ${JSON.stringify(databasePlan.sql)}`,
		);
		expect((await store.getJob("db-job"))?.status).toBe("completed");
	});
});

function memoryStore(): SessionMemoryStore {
	return {
		read: async () => [],
		append: async (_sessionId, messages) => messages,
		clear: async () => undefined,
	};
}

const databasePlanningContext: DatabasePlanningContext = {
	catalog: {
		datasource: "lms-readonly",
		tables: [
			{
				schema: "public",
				name: "users",
				description: "learner users",
				columns: [
					{ name: "id" },
					{ name: "email", sensitive: true },
					{ name: "status" },
				],
			},
		],
	},
	policy: {
		enabled: true,
		datasource: "lms-readonly",
		allowedSchemas: ["public"],
		allowedTables: ["public.users"],
		maxRows: 50,
		maxBytes: 50_000,
		timeoutMs: 2_000,
		maskColumns: ["email"],
	},
};

async function createDatabasePlan(requestId: string, requestedBy: string) {
	const result = await planNaturalLanguageDatabaseQuery({
		question: "show learner users id and email",
		catalog: databasePlanningContext.catalog,
		policy: databasePlanningContext.policy,
		requestId,
		requestedBy,
		now: "2026-10-05T00:00:00.000Z",
	});
	if (!result.ok) throw new Error(result.reason);
	return result.plan;
}

function discordJob(): DiscordJob {
	return {
		interactionId: "interaction",
		interactionToken: "token",
		applicationId: "app",
		userId: "user",
		channelId: "channel",
		guildId: "guild",
		action: "chat",
		text: "repo: codemonday-dev/lms-backend\nbranch: dev\nfind the rate limit",
		repository: "codemonday-dev/lms-backend",
		branch: "dev",
		question: "find the rate limit",
	};
}
