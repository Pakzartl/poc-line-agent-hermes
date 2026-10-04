import { describe, expect, test } from "bun:test";
import { createMemoryCapabilityJobStore } from "../capabilities/job-store";
import { loadConfig } from "../config";
import { createDeployPlan } from "../deploy/plan";
import type { SessionMemoryStore } from "../memory/types";
import { createPassThroughTelegramUpdateStore } from "../telegram/update-store";
import { processDiscordQueueMessage, type DiscordJob } from "./job";

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
						return { text: "Risk answer" };
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

		expect(JSON.stringify(hermesInputs[0])).toContain(
			"blast radius, side effects",
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
		expect(replyOptions.attachment?.data).toContain("Verify blast radius");
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
		expect(replies[0]?.[2]).toContain("database execution is disabled");
	});
});

function memoryStore(): SessionMemoryStore {
	return {
		read: async () => [],
		append: async (_sessionId, messages) => messages,
		clear: async () => undefined,
	};
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
