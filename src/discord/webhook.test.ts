import { describe, expect, test } from "bun:test";
import { createMemoryCapabilityJobStore } from "../capabilities/job-store";
import { loadConfig } from "../config";
import { createDeployPlan } from "../deploy/plan";
import { createPassThroughTelegramUpdateStore } from "../telegram/update-store";
import type { DiscordJob } from "./job";
import { handleDiscordInteraction, type DiscordWebhookDeps } from "./webhook";

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
			guild_id: "guild",
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
			guild_id: "guild",
			member: { user: { id: "9001" } },
			data: {
				name: "risk",
				options: [
					{ name: "repository", value: "codemonday-dev/lms-backend" },
					{ name: "branch", value: "feature/source-picker" },
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
			},
		});
		expect(jobs[0]?.text).toContain("Human Test Plan");
	});

	test("queues database command as a guarded capability job", async () => {
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

		expect((await response.json()) as unknown).toEqual({
			type: 5,
			data: { flags: 64 },
		});
		expect(jobs).toHaveLength(1);
		expect(jobs[0]).toMatchObject({
			question: "how many users signed up?",
			capability: {
				kind: "database_query",
				question: "how many users signed up?",
			},
		});
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
			guild_id: "guild",
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
			guildId: "guild",
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
			guildId: "guild",
			action: "deploy",
			actionDigest: plan.digest,
		});
		const fixture = await discordFixture({
			id: "component",
			application_id: "123",
			token: "token",
			type: 3,
			channel_id: "channel",
			guild_id: "guild",
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

function deps(publicKey: string, jobs: DiscordJob[] = []): DiscordWebhookDeps {
	return {
		config: loadConfig({
			DISCORD_APPLICATION_ID: "123",
			DISCORD_PUBLIC_KEY: publicKey,
			DISCORD_ALLOWED_USER_IDS: "9001",
		}),
		discordJobQueue: {
			send: async (job) => {
				jobs.push(job);
			},
		},
		discordUpdateStore: createPassThroughTelegramUpdateStore(),
	};
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
