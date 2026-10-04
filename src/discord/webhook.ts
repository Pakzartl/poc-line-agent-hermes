import { renderCapabilityList } from "../capabilities/manifest";
import type { AppConfig } from "../config";
import type { CapabilityJobStore } from "../capabilities/job-store";
import type { CodeSourceClient } from "../telegram/code-source";
import { parseScreenshotTargets } from "../artifacts/request";
import { isValidGitRef, isValidRepository } from "../telegram/source-scope";
import type { TelegramUpdateStore } from "../telegram/update-store";
import {
	createDeployPlan,
	parseDeployTargets,
	type DeployPlan,
} from "../deploy/plan";
import { discordSessionId, type DiscordJob, type DiscordJobQueue } from "./job";
import { verifyDiscordRequest } from "./signature";
import {
	discordEphemeralFlag,
	type DiscordCommandOption,
	type DiscordInteraction,
	DiscordInteractionResponseType,
	DiscordInteractionType,
	type DiscordArtifactKind,
} from "./types";

export type DiscordWebhookDeps = {
	config: AppConfig;
	discordJobQueue: DiscordJobQueue;
	discordUpdateStore: TelegramUpdateStore;
	discordCodeSourceClient?: CodeSourceClient;
	capabilityJobStore?: CapabilityJobStore;
};

const maxDiscordBodyBytes = 1_000_000;
const maxAutocompleteChoices = 25;
const sourceScopedCommands = new Set(["code", "risk", "deploy"]);
const capabilityComponentPrefix = "cap:";

export async function handleDiscordInteraction(
	request: Request,
	deps: DiscordWebhookDeps,
): Promise<Response> {
	const contentLength = Number(request.headers.get("content-length") ?? "0");
	if (contentLength > maxDiscordBodyBytes) {
		return new Response("payload too large", { status: 413 });
	}
	const body = await request.text();
	if (new TextEncoder().encode(body).byteLength > maxDiscordBodyBytes) {
		return new Response("payload too large", { status: 413 });
	}
	const validSignature = await verifyDiscordRequest({
		body,
		publicKey: deps.config.discord.publicKey,
		signature: request.headers.get("x-signature-ed25519"),
		timestamp: request.headers.get("x-signature-timestamp"),
	});
	if (!validSignature) {
		return new Response("invalid request signature", { status: 401 });
	}

	let interaction: DiscordInteraction;
	try {
		interaction = JSON.parse(body) as DiscordInteraction;
	} catch {
		return new Response("invalid JSON", { status: 400 });
	}
	if (interaction.application_id !== deps.config.discord.applicationId) {
		return new Response("application mismatch", { status: 401 });
	}
	if (interaction.type === DiscordInteractionType.ping) {
		return discordResponse({ type: DiscordInteractionResponseType.pong });
	}

	const user = interaction.member?.user ?? interaction.user;
	if (!user?.id || user.bot) {
		return ephemeralResponse("This interaction requires a Discord user.");
	}
	if (!deps.config.discord.allowedUserIds.includes(user.id)) {
		return ephemeralResponse("You are not authorized to use this agent.");
	}
	if (
		interaction.type === DiscordInteractionType.applicationCommandAutocomplete
	) {
		return handleAutocomplete(interaction, deps);
	}
	if (interaction.type === DiscordInteractionType.messageComponent) {
		return handleComponent(interaction, user.id, deps);
	}
	if (interaction.type !== DiscordInteractionType.applicationCommand) {
		return ephemeralResponse("Unsupported Discord interaction.");
	}
	if (interaction.data?.name === "status" && deps.capabilityJobStore) {
		return handleStatusCommand(interaction, user.id, deps.capabilityJobStore);
	}

	const parsed = parseCommand(interaction, user.id);
	if (!parsed.ok) {
		return ephemeralResponse(parsed.error);
	}
	if (parsed.kind === "immediate") {
		return ephemeralResponse(parsed.content);
	}
	let job = parsed.job;
	if (job.capability?.kind === "deploy_request") {
		const prepared = await prepareDeployJob(job, deps);
		if (!prepared.ok) {
			return ephemeralResponse(prepared.error);
		}
		job = prepared.job;
	}
	const canonicalInputHash =
		job.deployPlan?.digest ?? (await hashCanonicalInput(job.text));
	if (job.capability && deps.capabilityJobStore) {
		await deps.capabilityJobStore.createJob({
			jobId: job.interactionId,
			capability: job.capability.kind,
			userId: job.userId,
			guildId: job.guildId,
			channelId: job.channelId,
			actionDigest: canonicalInputHash,
			objective: job.question ?? job.text,
			metadata: {
				delivery: job.delivery ?? "interaction",
				...(job.repository ? { repository: job.repository } : {}),
				...(job.branch ? { branch: job.branch } : {}),
				...(job.deployPlan
					? { deployPlan: JSON.stringify(job.deployPlan) }
					: {}),
			},
		});
	}
	const claim = await deps.discordUpdateStore.claim({
		providerSessionId: job.providerSessionId ?? discordSessionId(job),
		idempotencyKey:
			job.idempotencyKey ?? `discord:interaction:${job.interactionId}`,
		canonicalInputHash,
		updateId: job.interactionId,
	});
	if (!claim.claimed) {
		return deferredResponse();
	}
	const queuedJob: DiscordJob = {
		...job,
		canonicalInputHash,
		sessionSequence: claim.record?.sessionSequence,
		generation: claim.record?.generation,
	};
	try {
		await deps.discordJobQueue.send(queuedJob);
	} catch (error) {
		await deps.discordUpdateStore.release({
			providerSessionId:
				queuedJob.providerSessionId ?? discordSessionId(queuedJob),
			idempotencyKey:
				queuedJob.idempotencyKey ??
				`discord:interaction:${queuedJob.interactionId}`,
		});
		if (job.capability && deps.capabilityJobStore) {
			await deps.capabilityJobStore.transitionJob({
				jobId: job.interactionId,
				from: "queued",
				to: "failed",
				detail: "Discord queue enqueue failed",
			});
		}
		console.error(
			JSON.stringify({
				message: "discord job enqueue failed",
				interactionId: queuedJob.interactionId,
				error: error instanceof Error ? error.message : "Unknown error",
			}),
		);
		return ephemeralResponse("Could not queue the request. Please try again.");
	}
	return deferredResponse();
}

async function handleStatusCommand(
	interaction: DiscordInteraction,
	userId: string,
	store: CapabilityJobStore,
): Promise<Response> {
	const requestId = stringOption(
		interaction.data?.options ?? [],
		"request_id",
	)?.trim();
	if (!requestId) {
		return ephemeralResponse(
			"ระบุ request_id ที่ได้จากงานก่อนหน้า เช่น `/status request_id:<id>`",
		);
	}
	const record = await store.getJob(requestId);
	if (
		!record ||
		record.userId !== userId ||
		(record.guildId && record.guildId !== interaction.guild_id)
	) {
		return ephemeralResponse("ไม่พบงานนี้ หรือคุณไม่มีสิทธิ์ดูสถานะงานนี้");
	}
	return ephemeralResponse(
		[
			`**${record.capability}** — \`${record.status}\``,
			`Request ID: \`${record.jobId}\``,
			`Updated: ${record.updatedAt}`,
			record.audit.at(-1)?.detail,
		]
			.filter(Boolean)
			.join("\n"),
	);
}

async function handleAutocomplete(
	interaction: DiscordInteraction,
	deps: DiscordWebhookDeps,
): Promise<Response> {
	const codeSourceClient = deps.discordCodeSourceClient;
	const focused = findFocusedOption(interaction.data?.options ?? []);
	if (!interaction.data?.name || !focused) {
		return autocompleteResponse([]);
	}
	const query = typeof focused.value === "string" ? focused.value : "";
	try {
		if (interaction.data.name === "artifact" && focused.name === "target_id") {
			return autocompleteResponse(
				toChoices(
					parseScreenshotTargets(
						deps.config.capabilities?.artifactScreenshotTargetsJson,
					).map((target) => target.id),
					query,
				),
			);
		}
		if (!sourceScopedCommands.has(interaction.data.name)) {
			return autocompleteResponse([]);
		}
		if (interaction.data.name === "deploy" && focused.name === "target") {
			return autocompleteResponse(
				toChoices(
					parseDeployTargets(deps.config.capabilities?.deployTargetsJson).map(
						(target) => target.id,
					),
					query,
				),
			);
		}
		if (!codeSourceClient) {
			return autocompleteResponse([]);
		}
		if (focused.name === "repository") {
			const repositories = await codeSourceClient.listRepositories();
			return autocompleteResponse(toChoices(repositories, query));
		}
		if (focused.name === "branch") {
			const repository = stringOption(
				interaction.data?.options ?? [],
				"repository",
			);
			if (!repository || !isValidRepository(repository)) {
				return autocompleteResponse([]);
			}
			const branches = await codeSourceClient.listBranches(repository);
			return autocompleteResponse(toChoices(branches, query));
		}
	} catch (error) {
		console.warn(
			JSON.stringify({
				message: "discord autocomplete failed",
				interactionId: interaction.id,
				error: error instanceof Error ? error.message : "Unknown error",
			}),
		);
	}
	return autocompleteResponse([]);
}

async function prepareDeployJob(
	job: DiscordJob,
	deps: DiscordWebhookDeps,
): Promise<
	| { ok: true; job: DiscordJob & { deployPlan: DeployPlan } }
	| { ok: false; error: string }
> {
	if (job.capability?.kind !== "deploy_request") {
		return { ok: false, error: "Deploy payload is invalid." };
	}
	if (!deps.capabilityJobStore) {
		return {
			ok: false,
			error: "Deploy is disabled because approval storage is unavailable.",
		};
	}
	const config = deps.config.capabilities;
	if (!config?.deployTargetsJson || !config.deployExecutorToken) {
		return {
			ok: false,
			error:
				"Deploy is disabled until DEPLOY_TARGETS_JSON and DEPLOY_EXECUTOR_TOKEN are configured.",
		};
	}
	try {
		const existing = await deps.capabilityJobStore.getJob(job.interactionId);
		const existingPlan = parseStoredDeployPlan(existing?.metadata.deployPlan);
		if (existingPlan) {
			if (
				existingPlan.repository !== job.capability.repository ||
				existingPlan.commitSha !== job.capability.commitSha.toLowerCase() ||
				existingPlan.targetId !== job.capability.target ||
				existingPlan.requestedBy !== job.userId
			) {
				return {
					ok: false,
					error: "Deploy request replay does not match its stored plan.",
				};
			}
			return { ok: true, job: { ...job, deployPlan: existingPlan } };
		}
		const deployPlan = await createDeployPlan(
			{
				targetId: job.capability.target,
				repository: job.capability.repository,
				commitSha: job.capability.commitSha,
				requestedBy: job.userId,
				now: discordSnowflakeDate(job.interactionId),
			},
			parseDeployTargets(config.deployTargetsJson),
		);
		return { ok: true, job: { ...job, deployPlan } };
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : "Deploy plan is invalid.",
		};
	}
}

function parseStoredDeployPlan(
	value: string | undefined,
): DeployPlan | undefined {
	if (!value) return undefined;
	try {
		const plan = JSON.parse(value) as Partial<DeployPlan>;
		if (
			plan.version !== "DEPLOY_PLAN_V1" ||
			typeof plan.id !== "string" ||
			typeof plan.targetId !== "string" ||
			typeof plan.targetName !== "string" ||
			!(["development", "staging", "production"] as const).includes(
				plan.environment as "development" | "staging" | "production",
			) ||
			typeof plan.repository !== "string" ||
			!isCommitSha(plan.commitSha ?? "") ||
			typeof plan.requestedBy !== "string" ||
			typeof plan.createdAt !== "string" ||
			typeof plan.expiresAt !== "string" ||
			typeof plan.digest !== "string" ||
			!plan.rollback ||
			plan.rollback.requiresSeparateApproval !== true
		) {
			return undefined;
		}
		return plan as DeployPlan;
	} catch {
		return undefined;
	}
}

function discordSnowflakeDate(id: string): Date | undefined {
	if (!/^\d{17,20}$/.test(id)) return undefined;
	try {
		const milliseconds = Number((BigInt(id) >> 22n) + 1420070400000n);
		const date = new Date(milliseconds);
		return Number.isNaN(date.getTime()) ? undefined : date;
	} catch {
		return undefined;
	}
}

async function handleComponent(
	interaction: DiscordInteraction,
	userId: string,
	deps: DiscordWebhookDeps,
): Promise<Response> {
	const customId = interaction.data?.custom_id;
	const match = customId?.match(
		/^cap:(approve|reject):(approval_[A-Za-z0-9_-]+)$/,
	);
	if (!match || !customId?.startsWith(capabilityComponentPrefix)) {
		return ephemeralResponse("Unsupported Discord component.");
	}
	if (!deps.capabilityJobStore) {
		return ephemeralResponse("Capability approval storage is unavailable.");
	}
	const action = match[1];
	const approvalId = match[2];
	if ((action !== "approve" && action !== "reject") || !approvalId) {
		return ephemeralResponse("Unsupported Discord component.");
	}
	const approval = await deps.capabilityJobStore.getApproval(approvalId);
	if (!approval) {
		return ephemeralResponse("Approval request was not found.");
	}
	if (
		approval.userId !== userId ||
		(approval.guildId ?? undefined) !== (interaction.guild_id ?? undefined)
	) {
		return ephemeralResponse(
			"This approval belongs to another user or server.",
		);
	}
	if (approval.status !== "pending") {
		return ephemeralResponse(`This approval is already ${approval.status}.`);
	}
	const record = await deps.capabilityJobStore.getJob(approval.jobId);
	const deployPlan = parseStoredDeployPlan(record?.metadata.deployPlan);
	if (
		!record ||
		record.status !== "waiting_approval" ||
		!deployPlan ||
		deployPlan.digest !== approval.actionDigest
	) {
		return ephemeralResponse(
			"The immutable deploy plan is unavailable or stale.",
		);
	}
	const decision = action === "approve" ? "approved" : "rejected";
	const decided = await deps.capabilityJobStore.decideApproval({
		approvalId,
		decision,
		userId,
		...(interaction.guild_id ? { guildId: interaction.guild_id } : {}),
		actionDigest: approval.actionDigest,
	});
	if (!decided || decided.status !== decision) {
		return ephemeralResponse("The approval could not be recorded.");
	}
	if (decision === "rejected") {
		return ephemeralResponse(
			`Deploy request \`${record.jobId}\` was rejected. No deployment was run.`,
		);
	}

	const capability = {
		kind: "deploy_request" as const,
		repository: deployPlan.repository,
		commitSha: deployPlan.commitSha,
		target: deployPlan.targetId,
	};
	const executionJob: DiscordJob = {
		interactionId: interaction.id,
		interactionToken: interaction.token,
		applicationId: interaction.application_id,
		userId,
		...(interaction.channel_id ? { channelId: interaction.channel_id } : {}),
		...(interaction.guild_id ? { guildId: interaction.guild_id } : {}),
		action: "deploy_execute",
		capability,
		text: `execute approved deploy ${deployPlan.id}`,
		repository: deployPlan.repository,
		branch: deployPlan.commitSha,
		question: deployPlan.targetId,
		capabilityJobId: record.jobId,
		deployPlan,
		deployApprovalId: approvalId,
		approvedBy: userId,
		providerSessionId: `discord:deploy:${record.jobId}`,
		idempotencyKey: `discord:deploy-approval:${approvalId}`,
		canonicalInputHash: deployPlan.digest,
	};
	const executionProviderSessionId = `discord:deploy:${record.jobId}`;
	const executionIdempotencyKey = `discord:deploy-approval:${approvalId}`;
	const claim = await deps.discordUpdateStore.claim({
		providerSessionId: executionProviderSessionId,
		idempotencyKey: executionIdempotencyKey,
		canonicalInputHash: deployPlan.digest,
		updateId: interaction.id,
	});
	if (!claim.claimed) {
		return ephemeralResponse(
			"This approved deploy is already being processed.",
		);
	}
	try {
		await deps.discordJobQueue.send({
			...executionJob,
			sessionSequence: claim.record?.sessionSequence,
			generation: claim.record?.generation,
		});
	} catch (error) {
		await deps.discordUpdateStore.release({
			providerSessionId: executionProviderSessionId,
			idempotencyKey: executionIdempotencyKey,
		});
		await deps.capabilityJobStore.transitionJob({
			jobId: record.jobId,
			from: "running",
			to: "failed",
			detail: "Approved deploy could not be queued",
			actorUserId: userId,
		});
		console.error(
			JSON.stringify({
				message: "approved deploy enqueue failed",
				jobId: record.jobId,
				error: error instanceof Error ? error.message : "Unknown error",
			}),
		);
		return ephemeralResponse(
			"Approval was recorded, but deploy queueing failed.",
		);
	}
	return deferredResponse();
}

function parseCommand(
	interaction: DiscordInteraction,
	userId: string,
):
	| { ok: true; kind: "job"; job: DiscordJob }
	| { ok: true; kind: "immediate"; content: string }
	| { ok: false; error: string } {
	const command = interaction.data?.name;
	const options = interaction.data?.options ?? [];
	const base = {
		interactionId: interaction.id,
		interactionToken: interaction.token,
		applicationId: interaction.application_id,
		userId,
		channelId: interaction.channel_id,
		guildId: interaction.guild_id,
		idempotencyKey: `discord:interaction:${interaction.id}`,
	};
	const sessionId = discordSessionId(base);
	if (command === "clear") {
		return {
			ok: true,
			kind: "job",
			job: {
				...base,
				providerSessionId: sessionId,
				action: "clear",
				text: "/clear",
			},
		};
	}
	if (command === "ask") {
		const question = stringOption(options, "question")?.trim();
		if (!question) {
			return { ok: false, error: "The question option is required." };
		}
		return {
			ok: true,
			kind: "job",
			job: {
				...base,
				providerSessionId: sessionId,
				action: "chat",
				text: question,
				question,
			},
		};
	}
	if (command === "code") {
		const scope = parseSourceScopeOptions(options);
		if (!scope.ok) {
			return scope;
		}
		const question = stringOption(options, "question")?.trim() ?? "";
		if (!question) {
			return { ok: false, error: "The question option is required." };
		}
		return {
			ok: true,
			kind: "job",
			job: {
				...base,
				providerSessionId: sessionId,
				action: "chat",
				text: `repo: ${scope.repository}\nbranch: ${scope.branch}\n${question}`,
				repository: scope.repository,
				branch: scope.branch,
				question,
				capability: {
					kind: "code_investigation",
					repository: scope.repository,
					branch: scope.branch,
					question,
				},
			},
		};
	}
	if (command === "risk") {
		const scope = parseSourceScopeOptions(options);
		if (!scope.ok) {
			return scope;
		}
		const change = stringOption(options, "change")?.trim() ?? "";
		const context = stringOption(options, "context")?.trim() || undefined;
		if (!change) {
			return { ok: false, error: "The change option is required." };
		}
		return {
			ok: true,
			kind: "job",
			job: {
				...base,
				providerSessionId: sessionId,
				action: "chat",
				text: [
					`repo: ${scope.repository}`,
					`branch: ${scope.branch}`,
					"Create a risk assessment for this implementation/deployment change.",
					"",
					change,
					context ? `\nAdditional context:\n${context}` : "",
					"",
					"Output a Human Test Plan and one-screen HIL artifact. Include blast radius, side effects, and where humans should test.",
				]
					.filter(Boolean)
					.join("\n"),
				repository: scope.repository,
				branch: scope.branch,
				question: change,
				capability: {
					kind: "risk_assessment",
					repository: scope.repository,
					branch: scope.branch,
					change,
					context,
				},
			},
		};
	}
	if (command === "db") {
		const question = stringOption(options, "question")?.trim();
		if (!question) {
			return { ok: false, error: "The question option is required." };
		}
		return {
			ok: true,
			kind: "job",
			job: {
				...base,
				providerSessionId: sessionId,
				action: "chat",
				text: question,
				question,
				capability: { kind: "database_query", question },
			},
		};
	}
	if (command === "artifact") {
		const artifactKind = stringOption(options, "kind")?.trim();
		const targetId = stringOption(options, "target_id")?.trim();
		const request = stringOption(options, "request")?.trim();
		if (!isArtifactKind(artifactKind) || !request) {
			return {
				ok: false,
				error: "The kind and request options are required.",
			};
		}
		if (artifactKind === "screenshot" && !targetId) {
			return {
				ok: false,
				error: "Screenshot artifacts require an allowlisted target_id.",
			};
		}
		if (targetId && !isSafeCapabilityId(targetId)) {
			return {
				ok: false,
				error: "Artifact target_id must be a safe allowlist id.",
			};
		}
		return {
			ok: true,
			kind: "job",
			job: {
				...base,
				providerSessionId: sessionId,
				action: "chat",
				text: [
					`artifact kind: ${artifactKind}`,
					targetId ? `target: ${targetId}` : "",
					request,
				]
					.filter(Boolean)
					.join("\n"),
				question: request,
				capability: {
					kind: "artifact_request",
					artifactKind,
					request,
					...(targetId ? { targetId } : {}),
				},
			},
		};
	}
	if (command === "deploy") {
		const repository = stringOption(options, "repository")?.trim() ?? "";
		const commitSha = stringOption(options, "commit_sha")?.trim() ?? "";
		const target = stringOption(options, "target")?.trim();
		if (!isValidRepository(repository)) {
			return { ok: false, error: "Repository must use owner/name format." };
		}
		if (!isCommitSha(commitSha)) {
			return {
				ok: false,
				error: "commit_sha must be an immutable 40-character git SHA.",
			};
		}
		if (!target) {
			return { ok: false, error: "The target option is required." };
		}
		if (!isSafeCapabilityId(target)) {
			return { ok: false, error: "Deploy target must be an allowlist id." };
		}
		const context = stringOption(options, "context")?.trim() || undefined;
		return {
			ok: true,
			kind: "job",
			job: {
				...base,
				providerSessionId: sessionId,
				action: "chat",
				text: [
					`repo: ${repository}`,
					`commit_sha: ${commitSha}`,
					`target: ${target}`,
					context,
				]
					.filter(Boolean)
					.join("\n"),
				repository,
				branch: commitSha,
				question: context ?? target,
				capability: {
					kind: "deploy_request",
					repository,
					commitSha,
					target,
					context,
				},
			},
		};
	}
	if (command === "status") {
		const requestId = stringOption(options, "request_id")?.trim() || undefined;
		return {
			ok: true,
			kind: "job",
			job: {
				...base,
				providerSessionId: sessionId,
				action: "status",
				text: requestId ? `status ${requestId}` : "status",
				question: requestId,
				capability: { kind: "status", requestId },
			},
		};
	}
	if (command === "skills") {
		return { ok: true, kind: "immediate", content: renderCapabilityList() };
	}
	return {
		ok: false,
		error:
			"Unknown command. Use /ask, /code, /risk, /db, /artifact, /deploy, /status, /skills, or /clear.",
	};
}

function isArtifactKind(
	value: string | undefined,
): value is DiscordArtifactKind {
	return (
		value === "markdown" ||
		value === "json" ||
		value === "csv" ||
		value === "diagram" ||
		value === "screenshot"
	);
}

function parseSourceScopeOptions(
	options: readonly DiscordCommandOption[],
):
	| { ok: true; repository: string; branch: string }
	| { ok: false; error: string } {
	const repository = stringOption(options, "repository")?.trim() ?? "";
	const branch = stringOption(options, "branch")?.trim() ?? "";
	if (!isValidRepository(repository)) {
		return { ok: false, error: "Repository must use owner/name format." };
	}
	if (!isValidGitRef(branch)) {
		return { ok: false, error: "Branch is not a valid Git ref." };
	}
	return { ok: true, repository, branch };
}

function isCommitSha(value: string): boolean {
	return /^[a-f0-9]{40}$/i.test(value);
}

function isSafeCapabilityId(value: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value);
}

function stringOption(
	options: readonly DiscordCommandOption[],
	name: string,
): string | undefined {
	for (const option of options) {
		if (option.name === name && typeof option.value === "string") {
			return option.value;
		}
		const nested = stringOption(option.options ?? [], name);
		if (nested !== undefined) {
			return nested;
		}
	}
	return undefined;
}

function findFocusedOption(
	options: readonly DiscordCommandOption[],
): DiscordCommandOption | undefined {
	for (const option of options) {
		if (option.focused) {
			return option;
		}
		const nested = findFocusedOption(option.options ?? []);
		if (nested) {
			return nested;
		}
	}
	return undefined;
}

function toChoices(
	values: readonly string[],
	query: string,
): { name: string; value: string }[] {
	const normalized = query.trim().toLowerCase();
	return values
		.filter(
			(value) =>
				value.length <= 100 &&
				(!normalized || value.toLowerCase().includes(normalized)),
		)
		.slice(0, maxAutocompleteChoices)
		.map((value) => ({ name: value, value }));
}

function deferredResponse(): Response {
	return discordResponse({
		type: DiscordInteractionResponseType.deferredChannelMessage,
		data: { flags: discordEphemeralFlag },
	});
}

function ephemeralResponse(content: string): Response {
	return discordResponse({
		type: DiscordInteractionResponseType.channelMessage,
		data: {
			content,
			flags: discordEphemeralFlag,
			allowed_mentions: { parse: [] },
		},
	});
}

function autocompleteResponse(
	choices: readonly { name: string; value: string }[],
): Response {
	return discordResponse({
		type: DiscordInteractionResponseType.autocompleteResult,
		data: { choices },
	});
}

function discordResponse(body: Record<string, unknown>): Response {
	return Response.json(body, {
		headers: { "Cache-Control": "no-store" },
	});
}

async function hashCanonicalInput(text: string): Promise<string> {
	const hash = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(text),
	);
	return [...new Uint8Array(hash)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}
