import { describe, expect, test } from "bun:test";
import { createMemoryCapabilityJobStore } from "../capabilities/job-store";
import { loadConfig } from "../config";
import {
	planNaturalLanguageDatabaseQuery,
	type DatabasePlanningContext,
} from "../db/nl-planner";
import { createDeployPlan } from "../deploy/plan";
import { createPassThroughTelegramUpdateStore } from "../telegram/update-store";
import type { DiscordJob } from "./job";
import { type DiscordWebhookDeps, handleDiscordInteraction } from "./webhook";

describe("Discord interactions webhook", () => {
	test("answers a signed Discord ping", async () => {
		const fixture = await discordFixture({
			id: "ping",
			application_id: "123",
			token: "token",
			type: 1,
		});
		const response = await handleDiscordInteraction(
			fixture.request,
			deps(fixture.publicKey),
		);

		expect(response.status).toBe(200);
		expect((await response.json()) as unknown).toEqual({ type: 1 });
	});

	test("defers an allowed command and queues its normalized job", async () => {
		const jobs: DiscordJob[] = [];
		const fixture = await discordFixture({
			id: "interaction",
			application_id: "123",
			token: "token",
			type: 2,
			channel_id: "channel",
			guild_id: "6001",
			member: { user: { id: "9001" } },
			data: {
				name: "code",
				options: [
					{ name: "repository", value: "codemonday-dev/lms-backend" },
					{ name: "branch", value: "dev" },
					{ name: "question", value: "find the rate limit" },
				],
			},
		});
		const response = await handleDiscordInteraction(
			fixture.request,
			deps(fixture.publicKey, jobs),
		);

		expect((await response.json()) as unknown).toEqual({
			type: 5,
			data: { flags: 64 },
		});
		expect(jobs).toHaveLength(1);
		expect(jobs[0]).toMatchObject({
			interactionId: "interaction",
			userId: "9001",
			repository: "codemonday-dev/lms-backend",
			branch: "dev",
			question: "find the rate limit",
			capability: {
				kind: "code_investigation",
				repository: "codemonday-dev/lms-backend",
				branch: "dev",
				question: "find the rate limit",
			},
		});
	});

	test("queues risk assessment as a typed source-scoped capability job", async () => {
		const jobs: DiscordJob[] = [];
		const fixture = await discordFixture({
			id: "risk-interaction",
			application_id: "123",
			token: "token",
			type: 2,
			channel_id: "channel",
			guild_id: "6001",
			member: { user: { id: "9001" } },
			data: {
				name: "risk",
				options: [
					{ name: "repository", value: "codemonday-dev/lms-backend" },
					{ name: "branch", value: "feature/source-picker" },
					{ name: "base_ref", value: "dev" },
					{ name: "change", value: "change throttler config" },
					{ name: "context", value: "deploy to learner gateway" },
				],
			},
		});
		const response = await handleDiscordInteraction(
			fixture.request,
			deps(fixture.publicKey, jobs),
		);

		expect((await response.json()) as unknown).toEqual({
			type: 5,
			data: { flags: 64 },
		});
		expect(jobs).toHaveLength(1);
		expect(jobs[0]).toMatchObject({
			repository: "codemonday-dev/lms-backend",
			branch: "feature/source-picker",
			question: "change throttler config",
			capability: {
				kind: "risk_assessment",
				repository: "codemonday-dev/lms-backend",
				branch: "feature/source-picker",
				change: "change throttler config",
				context: "deploy to learner gateway",
				baseRef: "dev",
			},
		});
		expect(jobs[0]?.text).toContain("Human Test Plan");
	});

	test("fails closed before queueing when database capability is disabled", async () => {
		const jobs: DiscordJob[] = [];
		const fixture = await discordFixture({
			id: "db-disabled",
			application_id: "123",
			token: "token",
			type: 2,
			channel_id: "channel",
			member: { user: { id: "9001" } },
			data: {
				name: "db",
				options: [{ name: "question", value: "how many users signed up?" }],
			},
		});
		const response = await handleDiscordInteraction(
			fixture.request,
			deps(fixture.publicKey, jobs),
		);

		const payload = (await response.json()) as {
			type: number;
			data: { content: string; flags: number };
		};
		expect(payload.type).toBe(4);
		expect(payload.data.content).toContain("database queries are disabled");
		expect(jobs).toHaveLength(0);
	});

	test("queues an immutable natural-language database plan", async () => {
		const jobs: DiscordJob[] = [];
		const store = createMemoryCapabilityJobStore();
		const fixture = await discordFixture({
			id: "db-planned",
			application_id: "123",
			token: "token",
			type: 2,
			channel_id: "channel",
			guild_id: "6001",
			member: { user: { id: "9001" } },
			data: {
				name: "db",
				options: [{ name: "question", value: "show learner users status" }],
			},
		});
		const response = await handleDiscordInteraction(
			fixture.request,
			deps(fixture.publicKey, jobs, {
				capabilityJobStore: store,
				databasePlanningContext,
			}),
		);

		expect((await response.json()) as unknown).toEqual({
			type: 5,
			data: { flags: 64 },
		});
		expect(jobs).toHaveLength(1);
		expect(jobs[0]?.databasePlan).toMatchObject({
			question: "show learner users status",
			sql: "SELECT status FROM public.users LIMIT 50",
			requestedBy: "9001",
		});
		expect(jobs[0]?.canonicalInputHash).toBe(jobs[0]?.databasePlan?.planDigest);
		expect((await store.getJob("db-planned"))?.metadata.databasePlan).toContain(
			'"version":"DB_NL_PLAN_V1"',
		);
	});

	test("queues artifact command as a guarded capability job", async () => {
		const jobs: DiscordJob[] = [];
		const fixture = await discordFixture({
			id: "artifact-disabled",
			application_id: "123",
			token: "token",
			type: 2,
			channel_id: "channel",
			member: { user: { id: "9001" } },
			data: {
				name: "artifact",
				options: [
					{ name: "kind", value: "screenshot" },
					{ name: "request", value: "capture partner page" },
					{ name: "target_id", value: "learner-preview" },
				],
			},
		});
		const response = await handleDiscordInteraction(
			fixture.request,
			deps(fixture.publicKey, jobs),
		);

		expect((await response.json()) as unknown).toEqual({
			type: 5,
			data: { flags: 64 },
		});
		expect(jobs).toHaveLength(1);
		expect(jobs[0]).toMatchObject({
			question: "capture partner page",
			capability: {
				kind: "artifact_request",
				artifactKind: "screenshot",
				request: "capture partner page",
				targetId: "learner-preview",
			},
		});
	});

	test("queues a screenshot for the explicit public HTTPS URL", async () => {
		const jobs: DiscordJob[] = [];
		const fixture = await discordFixture({
			id: "artifact-url",
			application_id: "123",
			token: "token",
			type: 2,
			channel_id: "channel",
			member: { user: { id: "9001" } },
			data: {
				name: "artifact",
				options: [
					{ name: "kind", value: "screenshot" },
					{ name: "request", value: "capture the documentation" },
					{ name: "url", value: "https://example.com/docs" },
				],
			},
		});
		const response = await handleDiscordInteraction(
			fixture.request,
			deps(fixture.publicKey, jobs),
		);

		expect(response.status).toBe(200);
		expect(jobs[0]?.capability).toEqual({
			kind: "artifact_request",
			artifactKind: "screenshot",
			request: "capture the documentation",
			url: "https://example.com/docs",
		});
	});

	test("rejects unsafe or ambiguous screenshot targets", async () => {
		for (const options of [
			[
				{ name: "kind", value: "screenshot" },
				{ name: "request", value: "capture private page" },
				{ name: "url", value: "https://127.0.0.1/admin" },
			],
			[
				{ name: "kind", value: "screenshot" },
				{ name: "request", value: "capture one page" },
				{ name: "target_id", value: "javis-health" },
				{ name: "url", value: "https://example.com" },
			],
		]) {
			const jobs: DiscordJob[] = [];
			const fixture = await discordFixture({
				id: `artifact-invalid-${jobs.length}`,
				application_id: "123",
				token: "token",
				type: 2,
				channel_id: "channel",
				member: { user: { id: "9001" } },
				data: { name: "artifact", options },
			});
			const response = await handleDiscordInteraction(
				fixture.request,
				deps(fixture.publicKey, jobs),
			);

			expect(response.status).toBe(200);
			expect(jobs).toHaveLength(0);
			const body = (await response.json()) as { data?: { content?: string } };
			expect(body.data?.content).toMatch(
				/public HTTPS|either target_id or url/i,
			);
		}
	});

	test("requires immutable commit sha for disabled deploy command", async () => {
		const jobs: DiscordJob[] = [];
		const fixture = await discordFixture({
			id: "deploy-invalid",
			application_id: "123",
			token: "token",
			type: 2,
			channel_id: "channel",
			member: { user: { id: "9001" } },
			data: {
				name: "deploy",
				options: [
					{ name: "repository", value: "codemonday-dev/lms-backend" },
					{ name: "commit_sha", value: "dev" },
					{ name: "target", value: "worker-prod" },
				],
			},
		});
		const response = await handleDiscordInteraction(
			fixture.request,
			deps(fixture.publicKey, jobs),
		);

		expect((await response.json()) as unknown).toMatchObject({
			type: 4,
			data: {
				flags: 64,
				content: expect.stringContaining("40-character git SHA"),
			},
		});
		expect(jobs).toHaveLength(0);
	});

	test("queues only an allowlisted immutable deploy plan", async () => {
		const jobs: DiscordJob[] = [];
		const fixture = await discordFixture({
			id: "deploy-valid",
			application_id: "123",
			token: "token",
			type: 2,
			channel_id: "channel",
			guild_id: "6001",
			member: { user: { id: "9001" } },
			data: {
				name: "deploy",
				options: [
					{ name: "repository", value: "codemonday-dev/lms-backend" },
					{ name: "commit_sha", value: "a".repeat(40) },
					{ name: "target", value: "worker-prod" },
				],
			},
		});
		const dependencies = deps(fixture.publicKey, jobs);
		dependencies.config = loadConfig({
			DISCORD_APPLICATION_ID: "123",
			DISCORD_PUBLIC_KEY: fixture.publicKey,
			DISCORD_ALLOWED_USER_IDS: "9001",
			DISCORD_ALLOWED_GUILD_IDS: "6001",
			DEPLOY_TARGETS_JSON: JSON.stringify([
				{
					id: "worker-prod",
					displayName: "Worker production",
					environment: "production",
					allowedRepositories: ["codemonday-dev/lms-backend"],
					executorUrl: "https://deploy.example/run",
				},
			]),
			DEPLOY_EXECUTOR_TOKEN: "executor-token",
		});
		const store = createMemoryCapabilityJobStore();
		dependencies.capabilityJobStore = store;

		const response = await handleDiscordInteraction(
			fixture.request,
			dependencies,
		);

		expect((await response.json()) as unknown).toEqual({
			type: 5,
			data: { flags: 64 },
		});
		expect(jobs).toHaveLength(1);
		expect(jobs[0]?.deployPlan).toMatchObject({
			targetId: "worker-prod",
			repository: "codemonday-dev/lms-backend",
			commitSha: "a".repeat(40),
		});
		const stored = await store.getJob("deploy-valid");
		expect(stored?.actionDigest).toBe(jobs[0]?.deployPlan?.digest);
		expect(stored?.metadata.deployPlan).toContain("DEPLOY_PLAN_V1");
	});

	test("binds deploy approval to the stored immutable plan and queues execution", async () => {
		const jobs: DiscordJob[] = [];
		const store = createMemoryCapabilityJobStore();
		const plan = await createDeployPlan(
			{
				targetId: "worker-prod",
				repository: "codemonday-dev/lms-backend",
				commitSha: "a".repeat(40),
				requestedBy: "9001",
			},
			[
				{
					id: "worker-prod",
					displayName: "Worker production",
					environment: "production",
					allowedRepositories: ["codemonday-dev/lms-backend"],
					executorUrl: "https://deploy.example/run",
					requiresApproval: true,
				},
			],
		);
		await store.createJob({
			jobId: "request-1",
			capability: "deploy_request",
			userId: "9001",
			guildId: "6001",
			actionDigest: plan.digest,
			objective: "deploy",
			metadata: { deployPlan: JSON.stringify(plan) },
		});
		await store.transitionJob({
			jobId: "request-1",
			from: "queued",
			to: "running",
		});
		await store.requestApproval({
			approvalId: "approval_request-1",
			jobId: "request-1",
			userId: "9001",
			guildId: "6001",
			action: "deploy",
			actionDigest: plan.digest,
		});
		const fixture = await discordFixture({
			id: "component",
			application_id: "123",
			token: "token",
			type: 3,
			channel_id: "channel",
			guild_id: "6001",
			member: { user: { id: "9001" } },
			data: {
				custom_id: "cap:approve:approval_request-1",
			},
		});
		const dependencies = deps(fixture.publicKey, jobs);
		dependencies.capabilityJobStore = store;
		const response = await handleDiscordInteraction(
			fixture.request,
			dependencies,
		);

		expect((await response.json()) as unknown).toEqual({
			type: 5,
			data: { flags: 64 },
		});
		expect(jobs).toHaveLength(1);
		expect(jobs[0]).toMatchObject({
			action: "deploy_execute",
			capabilityJobId: "request-1",
			deployApprovalId: "approval_request-1",
			approvedBy: "9001",
			deployPlan: { digest: plan.digest },
		});
		expect((await store.getApproval("approval_request-1"))?.status).toBe(
			"approved",
		);
		expect((await store.getJob("request-1"))?.status).toBe("running");
	});

	test("binds database approval to the stored immutable plan and queues execution", async () => {
		const jobs: DiscordJob[] = [];
		const store = createMemoryCapabilityJobStore();
		const planned = await planNaturalLanguageDatabaseQuery({
			question: "show learner users status",
			catalog: databasePlanningContext.catalog,
			policy: databasePlanningContext.policy,
			requestId: "db-request-1",
			requestedBy: "9001",
			now: "2026-10-05T00:00:00.000Z",
		});
		expect(planned.ok).toBe(true);
		if (!planned.ok) return;
		await store.createJob({
			jobId: "db-request-1",
			capability: "database_query",
			userId: "9001",
			guildId: "6001",
			actionDigest: planned.plan.planDigest,
			objective: planned.plan.question,
			metadata: { databasePlan: JSON.stringify(planned.plan) },
		});
		await store.transitionJob({
			jobId: "db-request-1",
			from: "queued",
			to: "running",
		});
		await store.requestApproval({
			approvalId: "approval_db_db-request-1",
			jobId: "db-request-1",
			userId: "9001",
			guildId: "6001",
			action: "run database query",
			actionDigest: planned.plan.planDigest,
		});
		const fixture = await discordFixture({
			id: "db-component",
			application_id: "123",
			token: "token",
			type: 3,
			channel_id: "channel",
			guild_id: "6001",
			member: { user: { id: "9001" } },
			data: { custom_id: "cap:approve:approval_db_db-request-1" },
		});
		const response = await handleDiscordInteraction(
			fixture.request,
			deps(fixture.publicKey, jobs, {
				capabilityJobStore: store,
				databasePlanningContext,
			}),
		);

		expect((await response.json()) as unknown).toEqual({
			type: 5,
			data: { flags: 64 },
		});
		expect(jobs).toHaveLength(1);
		expect(jobs[0]).toMatchObject({
			action: "db_execute",
			capabilityJobId: "db-request-1",
			databaseApprovalId: "approval_db_db-request-1",
			approvedBy: "9001",
			databasePlan: { planDigest: planned.plan.planDigest },
		});
		expect((await store.getApproval("approval_db_db-request-1"))?.status).toBe(
			"approved",
		);
		expect((await store.getJob("db-request-1"))?.status).toBe("running");
	});

	test("rejects deploy approval from another user or guild", async () => {
		const { store } = await pendingDeployApproval();
		for (const identity of [
			{ userId: "9002", guildId: "6001" },
			{ userId: "9001", guildId: "6002" },
		]) {
			const fixture = await discordFixture({
				id: `component-${identity.userId}-${identity.guildId}`,
				application_id: "123",
				token: "token",
				type: 3,
				guild_id: identity.guildId,
				member: { user: { id: identity.userId } },
				data: { custom_id: "cap:approve:approval_request-1" },
			});
			const dependencies = deps(fixture.publicKey);
			dependencies.config = loadConfig({
				DISCORD_APPLICATION_ID: "123",
				DISCORD_PUBLIC_KEY: fixture.publicKey,
				DISCORD_ALLOWED_USER_IDS: "9001,9002",
				DISCORD_ALLOWED_GUILD_IDS: "6001,6002",
			});
			dependencies.capabilityJobStore = store;
			const response = await handleDiscordInteraction(
				fixture.request,
				dependencies,
			);
			expect(JSON.stringify(await response.json())).toContain(
				"another user or server",
			);
		}
		expect((await store.getApproval("approval_request-1"))?.status).toBe(
			"pending",
		);
	});

	test("treats deploy approvals as single-use and rejects replay", async () => {
		const jobs: DiscordJob[] = [];
		const { store } = await pendingDeployApproval();
		const invoke = async (id: string) => {
			const fixture = await discordFixture({
				id,
				application_id: "123",
				token: "token",
				type: 3,
				guild_id: "6001",
				member: { user: { id: "9001" } },
				data: { custom_id: "cap:approve:approval_request-1" },
			});
			const dependencies = deps(fixture.publicKey, jobs);
			dependencies.capabilityJobStore = store;
			return handleDiscordInteraction(fixture.request, dependencies);
		};

		expect((await invoke("component-first")).status).toBe(200);
		const replay = await invoke("component-replay");
		expect(JSON.stringify(await replay.json())).toContain("already approved");
		expect(jobs).toHaveLength(1);
	});

	test("rejects an expired deploy approval before queueing execution", async () => {
		const jobs: DiscordJob[] = [];
		const { store } = await pendingDeployApproval("2020-01-01T00:00:00.000Z");
		const fixture = await discordFixture({
			id: "component-expired",
			application_id: "123",
			token: "token",
			type: 3,
			guild_id: "6001",
			member: { user: { id: "9001" } },
			data: { custom_id: "cap:approve:approval_request-1" },
		});
		const dependencies = deps(fixture.publicKey, jobs);
		dependencies.capabilityJobStore = store;
		const response = await handleDiscordInteraction(
			fixture.request,
			dependencies,
		);
		expect(JSON.stringify(await response.json())).toContain("already expired");
		expect(jobs).toHaveLength(0);
	});

	test("returns repository autocomplete choices from every visible repo", async () => {
		const fixture = await discordFixture({
			id: "autocomplete",
			application_id: "123",
			token: "token",
			type: 4,
			user: { id: "9001" },
			data: {
				name: "code",
				options: [{ name: "repository", value: "lms", focused: true }],
			},
		});
		const dependencies = deps(fixture.publicKey);
		dependencies.discordCodeSourceClient = {
			listRepositories: async () => [
				"codemonday-dev/lms-backend",
				"Pakzartl/poc-line-agent",
			],
			listBranches: async () => [],
			branchExists: async () => false,
		};
		const response = await handleDiscordInteraction(
			fixture.request,
			dependencies,
		);

		expect((await response.json()) as unknown).toEqual({
			type: 8,
			data: {
				choices: [
					{
						name: "codemonday-dev/lms-backend",
						value: "codemonday-dev/lms-backend",
					},
				],
			},
		});
	});

	test("returns only server-owned artifact targets in autocomplete", async () => {
		const fixture = await discordFixture({
			id: "artifact-autocomplete",
			application_id: "123",
			token: "token",
			type: 4,
			user: { id: "9001" },
			data: {
				name: "artifact",
				options: [{ name: "target_id", value: "health", focused: true }],
			},
		});
		const dependencies = deps(fixture.publicKey);
		dependencies.config = loadConfig({
			DISCORD_APPLICATION_ID: "123",
			DISCORD_PUBLIC_KEY: fixture.publicKey,
			DISCORD_ALLOWED_USER_IDS: "9001",
			ARTIFACT_SCREENSHOT_TARGETS_JSON: JSON.stringify([
				{ id: "javis-health", url: "https://agent.example/health" },
			]),
		});
		const response = await handleDiscordInteraction(
			fixture.request,
			dependencies,
		);

		expect((await response.json()) as unknown).toEqual({
			type: 8,
			data: {
				choices: [{ name: "javis-health", value: "javis-health" }],
			},
		});
	});

	test("rejects commands from a Discord guild outside the allowlist", async () => {
		const jobs: DiscordJob[] = [];
		const fixture = await discordFixture({
			id: "wrong-guild",
			application_id: "123",
			token: "token",
			type: 2,
			guild_id: "9999",
			member: { user: { id: "9001" } },
			data: { name: "skills" },
		});
		const response = await handleDiscordInteraction(
			fixture.request,
			deps(fixture.publicKey, jobs),
		);

		expect((await response.json()) as unknown).toMatchObject({
			type: 4,
			data: { content: expect.stringContaining("server is not authorized") },
		});
		expect(jobs).toHaveLength(0);
	});

	test("reports both job and approval status immediately", async () => {
		const store = createMemoryCapabilityJobStore();
		await store.createJob({
			jobId: "request-1",
			capability: "deploy_request",
			userId: "9001",
			guildId: "6001",
			actionDigest: "digest",
			objective: "deploy",
		});
		await store.transitionJob({
			jobId: "request-1",
			from: "queued",
			to: "running",
		});
		await store.requestApproval({
			approvalId: "approval_request-1",
			jobId: "request-1",
			userId: "9001",
			guildId: "6001",
			action: "deploy",
			actionDigest: "digest",
		});
		const dependencies = deps("");
		const jobFixture = await discordFixture({
			id: "status-job",
			application_id: "123",
			token: "token",
			type: 2,
			guild_id: "6001",
			member: { user: { id: "9001" } },
			data: {
				name: "status",
				options: [{ name: "request_id", value: "request-1" }],
			},
		});
		dependencies.config = loadConfig({
			DISCORD_APPLICATION_ID: "123",
			DISCORD_PUBLIC_KEY: jobFixture.publicKey,
			DISCORD_ALLOWED_USER_IDS: "9001",
			DISCORD_ALLOWED_GUILD_IDS: "6001",
		});
		dependencies.capabilityJobStore = store;
		const jobResponse = await handleDiscordInteraction(
			jobFixture.request,
			dependencies,
		);
		expect(JSON.stringify(await jobResponse.json())).toContain(
			"waiting_approval",
		);

		const approvalFixture = await discordFixture({
			id: "status-approval",
			application_id: "123",
			token: "token",
			type: 2,
			guild_id: "6001",
			member: { user: { id: "9001" } },
			data: {
				name: "status",
				options: [{ name: "request_id", value: "approval_request-1" }],
			},
		});
		dependencies.config = loadConfig({
			DISCORD_APPLICATION_ID: "123",
			DISCORD_PUBLIC_KEY: approvalFixture.publicKey,
			DISCORD_ALLOWED_USER_IDS: "9001",
			DISCORD_ALLOWED_GUILD_IDS: "6001",
		});
		const approvalResponse = await handleDiscordInteraction(
			approvalFixture.request,
			dependencies,
		);
		expect(JSON.stringify(await approvalResponse.json())).toContain(
			"approval_request-1",
		);
	});

	test("cancels an owned queued capability job without queueing work", async () => {
		const store = createMemoryCapabilityJobStore();
		await store.createJob({
			jobId: "request-cancel",
			capability: "code_investigation",
			userId: "9001",
			guildId: "6001",
			actionDigest: "digest",
			objective: "inspect",
		});
		const fixture = await discordFixture({
			id: "cancel-job",
			application_id: "123",
			token: "token",
			type: 2,
			guild_id: "6001",
			member: { user: { id: "9001" } },
			data: {
				name: "cancel",
				options: [{ name: "request_id", value: "request-cancel" }],
			},
		});
		const dependencies = deps(fixture.publicKey);
		dependencies.capabilityJobStore = store;
		const response = await handleDiscordInteraction(
			fixture.request,
			dependencies,
		);

		expect(JSON.stringify(await response.json())).toContain("request-cancel");
		expect((await store.getJob("request-cancel"))?.status).toBe("cancelled");
	});

	test("rejects a request whose body does not match the signature", async () => {
		const fixture = await discordFixture({
			id: "ping",
			application_id: "123",
			token: "token",
			type: 1,
		});
		const tampered = new Request(fixture.request.url, {
			method: "POST",
			headers: fixture.request.headers,
			body: '{"type":2}',
		});
		const response = await handleDiscordInteraction(
			tampered,
			deps(fixture.publicKey),
		);

		expect(response.status).toBe(401);
	});
});

function deps(
	publicKey: string,
	jobs: DiscordJob[] = [],
	overrides: Partial<DiscordWebhookDeps> = {},
): DiscordWebhookDeps {
	return {
		config: loadConfig({
			DISCORD_APPLICATION_ID: "123",
			DISCORD_PUBLIC_KEY: publicKey,
			DISCORD_ALLOWED_USER_IDS: "9001",
			DISCORD_ALLOWED_GUILD_IDS: "6001",
		}),
		discordJobQueue: {
			send: async (job) => {
				jobs.push(job);
			},
		},
		discordUpdateStore: createPassThroughTelegramUpdateStore(),
		...overrides,
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

async function pendingDeployApproval(now?: string) {
	const store = createMemoryCapabilityJobStore();
	const plan = await createDeployPlan(
		{
			targetId: "worker-prod",
			repository: "codemonday-dev/lms-backend",
			commitSha: "a".repeat(40),
			requestedBy: "9001",
			...(now ? { now: new Date(now) } : {}),
		},
		[
			{
				id: "worker-prod",
				displayName: "Worker production",
				environment: "production",
				allowedRepositories: ["codemonday-dev/lms-backend"],
				executorUrl: "https://deploy.example/run",
				requiresApproval: true,
			},
		],
	);
	await store.createJob({
		jobId: "request-1",
		capability: "deploy_request",
		userId: "9001",
		guildId: "6001",
		actionDigest: plan.digest,
		objective: "deploy",
		metadata: { deployPlan: JSON.stringify(plan) },
		...(now ? { now } : {}),
	});
	await store.transitionJob({
		jobId: "request-1",
		from: "queued",
		to: "running",
		...(now ? { now } : {}),
	});
	await store.requestApproval({
		approvalId: "approval_request-1",
		jobId: "request-1",
		userId: "9001",
		guildId: "6001",
		action: "deploy",
		actionDigest: plan.digest,
		ttlSeconds: 60,
		...(now ? { now } : {}),
	});
	return { store, plan };
}

async function discordFixture(payload: Record<string, unknown>) {
	const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
		"sign",
		"verify",
	]);
	const body = JSON.stringify(payload);
	const timestamp = "1720000000";
	const signature = new Uint8Array(
		await crypto.subtle.sign(
			{ name: "Ed25519" },
			keyPair.privateKey,
			new TextEncoder().encode(`${timestamp}${body}`),
		),
	);
	const publicKey = new Uint8Array(
		await crypto.subtle.exportKey("raw", keyPair.publicKey),
	);
	return {
		publicKey: toHex(publicKey),
		request: new Request("https://agent.example/discord/interactions", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Signature-Ed25519": toHex(signature),
				"X-Signature-Timestamp": timestamp,
			},
			body,
		}),
	};
}

function toHex(bytes: Uint8Array): string {
	return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
