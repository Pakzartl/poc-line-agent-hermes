import { ResponsesApiError } from "../agent/llm-client";
import type { AgentOrchestrator } from "../agent/orchestrator";
import { createArtifact, parseScreenshotTargets } from "../artifacts/request";
import {
	type HilArtifactV1,
	hilArtifactVersion,
	renderHilArtifactMarkdown,
	safeArtifactFilename,
} from "../capabilities/artifact";
import type { CapabilityJobStore } from "../capabilities/job-store";
import { renderCapabilityList } from "../capabilities/manifest";
import type { AppConfig } from "../config";
import type { DatabaseReadClient, DatabaseReadResult } from "../db/client";
import type {
	DatabasePlanningContext,
	NaturalLanguageDbQueryPlan,
} from "../db/nl-planner";
import { verifyNaturalLanguageDatabaseQueryPlan } from "../db/nl-planner";
import {
	type DeployExecutionResult,
	DeployExecutionUncertainError,
	executeApprovedDeploy,
} from "../deploy/executor";
import { type DeployPlan, parseDeployTargets } from "../deploy/plan";
import {
	findRecoveredAssistantMessage,
	HermesApiError,
	type HermesClient,
} from "../hermes/client";
import type { SessionMemoryStore } from "../memory/types";
import { formatHermesSourceInput } from "../telegram/source-scope";
import type { TelegramUpdateStore } from "../telegram/update-store";
import {
	DiscordApiError,
	type DiscordReplyAttachment,
	type DiscordReplyClient,
	type DiscordReplyOptions,
} from "./reply";
import type { DiscordCapabilityPayload } from "./types";

type FetchLike = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

export type DiscordJob = {
	interactionId: string;
	interactionToken?: string;
	applicationId: string;
	userId: string;
	channelId?: string;
	guildId?: string;
	delivery?: "interaction" | "channel";
	sourceMessageId?: string;
	progressMessageId?: string;
	action:
		| "chat"
		| "clear"
		| "status"
		| "skills"
		| "deploy_execute"
		| "db_execute";
	capability?: DiscordCapabilityPayload;
	text: string;
	repository?: string;
	branch?: string;
	question?: string;
	providerSessionId?: string;
	idempotencyKey?: string;
	canonicalInputHash?: string;
	sessionSequence?: number;
	generation?: string;
	capabilityJobId?: string;
	deployPlan?: DeployPlan;
	deployApprovalId?: string;
	databasePlan?: NaturalLanguageDbQueryPlan;
	databaseApprovalId?: string;
	approvedBy?: string;
};

export type DiscordJobQueue = {
	send(job: DiscordJob): Promise<void>;
};

export type DiscordJobProcessorDeps = {
	config: AppConfig;
	orchestrator: AgentOrchestrator;
	hermesClient?: HermesClient;
	discordReplyClient: DiscordReplyClient;
	discordUpdateStore: TelegramUpdateStore;
	capabilityJobStore?: CapabilityJobStore;
	databaseReadClient?: DatabaseReadClient;
	databasePlanningContext?: DatabasePlanningContext;
	memoryStore: SessionMemoryStore;
	fetch?: FetchLike;
};

type DiscordQueueMessage = {
	body: DiscordJob;
	attempts: number;
	ack(): void;
	retry(options?: { delaySeconds?: number }): void;
};

type DiscordJobAnswer = {
	text: string;
	attachment?: DiscordReplyAttachment;
	capabilityStatus?: "completed" | "failed";
};

const maxDeliveryAttempts = 3;
const deferredQueueDelaySeconds = 5;
const genericFailureMessage =
	"The agent could not complete this request. Please try again.";

class DiscordManualInterventionError extends Error {
	readonly retryable = true;
	readonly userMessage: string;

	constructor(message: string, userMessage = genericFailureMessage) {
		super(message);
		this.name = "DiscordManualInterventionError";
		this.userMessage = userMessage;
	}
}

export function discordSessionId(
	job: Pick<DiscordJob, "channelId" | "guildId" | "userId">,
): string {
	return `discord:channel:source-v1:${job.guildId ?? "dm"}:${job.channelId ?? "unknown"}:${job.userId}`;
}

export function createInlineDiscordJobQueue(
	deps: DiscordJobProcessorDeps,
): DiscordJobQueue {
	return {
		send: async (job) => {
			await processDiscordJob(job, deps);
		},
	};
}

export async function processDiscordQueueMessage(
	message: DiscordQueueMessage,
	deps: DiscordJobProcessorDeps,
): Promise<void> {
	try {
		const result = await processDiscordJob(message.body, deps);
		if (result === "deferred") {
			message.retry({ delaySeconds: deferredQueueDelaySeconds });
			return;
		}
		message.ack();
	} catch (error) {
		if (isRetryableJobError(error) && message.attempts < maxDeliveryAttempts) {
			message.retry({
				delaySeconds: 30 * 2 ** Math.max(0, message.attempts - 1),
			});
			return;
		}

		console.error(
			JSON.stringify({
				message: "discord agent job failed",
				interactionId: message.body.interactionId,
				error: describeError(error),
			}),
		);
		if (error instanceof DiscordManualInterventionError) {
			try {
				await beginReply(
					message.body,
					deps.discordUpdateStore,
					error.userMessage,
				);
				await deliverReply(message.body, deps, error.userMessage);
			} catch (replyError) {
				console.error(
					JSON.stringify({
						message: "discord manual-intervention reply failed",
						interactionId: message.body.interactionId,
						error: describeError(replyError),
					}),
				);
			}
			await terminalUpdate(
				message.body,
				deps.discordUpdateStore,
				"markUncertain",
				{
					terminalReason: describeError(error),
				},
			);
			await failCapabilityJob(message.body, deps, describeError(error));
			message.ack();
			return;
		}
		try {
			await beginReply(
				message.body,
				deps.discordUpdateStore,
				genericFailureMessage,
			);
			await deliverReply(message.body, deps, genericFailureMessage);
		} catch (replyError) {
			console.error(
				JSON.stringify({
					message: "discord terminal failure reply failed",
					interactionId: message.body.interactionId,
					error: describeError(replyError),
				}),
			);
		}
		await terminalUpdate(message.body, deps.discordUpdateStore, "fail", {
			terminalReason: describeError(error),
		});
		await failCapabilityJob(message.body, deps, describeError(error));
		message.ack();
	}
}

async function processDiscordJob(
	job: DiscordJob,
	deps: DiscordJobProcessorDeps,
): Promise<"processed" | "deferred"> {
	await ensureCapabilityJob(job, deps);
	const sessionId = discordSessionId(job);
	const route = selectDiscordRuntime(deps);
	const baseline =
		route === "hermes"
			? await deps.hermesClient?.lastMessageMarker(sessionId)
			: undefined;
	const lease = await deps.discordUpdateStore.dispatchLease({
		providerSessionId: job.providerSessionId ?? sessionId,
		idempotencyKey:
			job.idempotencyKey ?? `discord:interaction:${job.interactionId}`,
		canonicalInputHash:
			job.canonicalInputHash ?? (await hashCanonicalInput(job.text)),
		sessionSequence: job.sessionSequence,
		generation: job.generation,
		updateId: job.interactionId,
		baselineLastHermesMessageId: baseline?.id,
		baselineLastHermesMessageTimestamp: baseline?.timestamp,
	});
	if (lease.kind === "deferred") {
		return "deferred";
	}
	if (lease.kind === "duplicate") {
		if (lease.record?.status === "replying") {
			await recoverReplyOnly(job, deps, lease.record);
		}
		return "processed";
	}
	if (lease.kind === "recovery" && job.action === "chat") {
		await recoverHermesAnswer(job, deps, lease.record);
		return "processed";
	}
	if (await isCapabilityJobCancelled(job, deps)) {
		await terminalUpdate(job, deps.discordUpdateStore, "complete", {
			terminalReason: "Capability job cancelled before execution",
		});
		return "processed";
	}
	if (job.capability && deps.capabilityJobStore && !isApprovedExecution(job)) {
		await deps.capabilityJobStore.transitionJob({
			jobId: capabilityJobId(job),
			from: "queued",
			to: "running",
			detail: "Discord queue worker started capability execution",
		});
	}
	await updateInteractionProgress(job, deps.discordReplyClient);

	const stopTyping = await startTypingHeartbeat(job, deps.discordReplyClient);
	try {
		const answer =
			job.action === "clear"
				? { text: await clearConversation(deps, sessionId, route) }
				: await answerQuestion(job, deps, sessionId, route);
		if (await isCapabilityJobCancelled(job, deps)) {
			await terminalUpdate(job, deps.discordUpdateStore, "complete", {
				terminalReason: "Capability job cancelled before response delivery",
			});
			return "processed";
		}
		const responseText = job.capability
			? `${answer.text}\n\nRequest ID: \`${capabilityJobId(job)}\``
			: answer.text;
		const replyOptions = await buildDiscordReplyOptions(
			job,
			deps,
			responseText,
			answer.attachment,
		);
		await sendReply(job, deps, responseText, replyOptions);
		await terminalUpdate(job, deps.discordUpdateStore, "complete", {
			replyContentHash: await hashCanonicalInput(responseText),
		});
		if (job.capability && deps.capabilityJobStore && !isApprovalRequest(job)) {
			await deps.capabilityJobStore.transitionJob({
				jobId: capabilityJobId(job),
				from: "running",
				to: answer.capabilityStatus ?? "completed",
				detail:
					answer.capabilityStatus === "failed"
						? "Capability failed; Discord failure artifact delivered"
						: "Discord response and HIL artifact delivered",
			});
		}
		return "processed";
	} finally {
		stopTyping();
	}
}

async function answerQuestion(
	job: DiscordJob,
	deps: DiscordJobProcessorDeps,
	sessionId: string,
	route: "legacy" | "hermes",
): Promise<DiscordJobAnswer> {
	if (job.action === "deploy_execute") {
		return executeDeploy(job, deps);
	}
	if (job.action === "db_execute") {
		return executeDatabasePlan(job, deps);
	}
	if (job.action === "status") {
		return {
			text: [
				"Javis is online.",
				`Runtime: ${route}`,
				"Available Discord commands: /ask, /code, /risk, /db, /artifact, /deploy, /status, /skills, /clear",
				"Safety: deploy is approval-gated; database requests do not execute live SQL unless a read-only DB tool is configured.",
			].join("\n"),
		};
	}
	if (job.action === "skills") {
		return { text: renderCapabilityList() };
	}
	if (job.capability?.kind === "artifact_request") {
		return captureArtifact(job, deps, sessionId, route);
	}
	if (job.capability?.kind === "database_query") {
		if (!job.databasePlan || !deps.databaseReadClient) {
			return {
				text: "Read-only database planning is unavailable or incomplete. No query was run.",
				capabilityStatus: "failed",
			};
		}
		return {
			text: formatDatabasePlan(job.databasePlan),
		};
	}
	if (route === "hermes") {
		if (!deps.hermesClient) {
			throw new Error("Hermes client is required for Discord Hermes runtime");
		}
		return {
			text: (
				await deps.hermesClient.chat({
					sessionId,
					source: "discord",
					input: hermesInput(job),
				})
			).text,
		};
	}
	try {
		const history = await deps.memoryStore.read(sessionId);
		const answer = await deps.orchestrator.answer(job.text, history);
		await deps.memoryStore.append(sessionId, [
			{ role: "user", content: job.text },
			{ role: "assistant", content: answer },
		]);
		return { text: answer };
	} catch (error) {
		if (error instanceof ResponsesApiError && error.retryable) {
			await deps.discordUpdateStore.retryPreReply({
				providerSessionId: job.providerSessionId ?? sessionId,
				idempotencyKey:
					job.idempotencyKey ?? `discord:interaction:${job.interactionId}`,
			});
		}
		throw error;
	}
}

async function clearConversation(
	deps: DiscordJobProcessorDeps,
	sessionId: string,
	route: "legacy" | "hermes",
): Promise<string> {
	if (route === "hermes") {
		if (!deps.hermesClient) {
			throw new Error("Hermes client is required for Discord Hermes runtime");
		}
		await deps.hermesClient.clearSession(sessionId);
	}
	await deps.memoryStore.clear(sessionId);
	return "Conversation cleared. Your next command will start a new session.";
}

async function recoverHermesAnswer(
	job: DiscordJob,
	deps: DiscordJobProcessorDeps,
	record: {
		baselineLastHermesMessageId?: string;
		baselineLastHermesMessageTimestamp?: string;
	},
): Promise<void> {
	if (!deps.hermesClient || selectDiscordRuntime(deps) !== "hermes") {
		throw new Error("Hermes recovery is unavailable for this Discord job");
	}
	const messages = await deps.hermesClient.listMessages(discordSessionId(job));
	const recovered = findRecoveredAssistantMessage({
		messages,
		userInput: hermesInput(job),
		baseline: {
			id: record.baselineLastHermesMessageId,
			timestamp: record.baselineLastHermesMessageTimestamp,
		},
	});
	if (!recovered) {
		throw new Error("Hermes answer is not available for Discord recovery yet");
	}
	const responseText = job.capability
		? `${recovered.content}\n\nRequest ID: \`${capabilityJobId(job)}\``
		: recovered.content;
	const replyOptions = await buildDiscordReplyOptions(job, deps, responseText);
	await sendReply(job, deps, responseText, replyOptions);
	await terminalUpdate(job, deps.discordUpdateStore, "complete", {
		recoveredAssistantMessageId: recovered.id,
		recoveredAssistantContentHash: await hashCanonicalInput(recovered.content),
		replyContentHash: await hashCanonicalInput(responseText),
	});
	if (job.capability && deps.capabilityJobStore) {
		await deps.capabilityJobStore.transitionJob({
			jobId: capabilityJobId(job),
			from: "queued",
			to: "running",
			detail: "Recovered Hermes answer",
		});
		if (!isApprovalRequest(job)) {
			await deps.capabilityJobStore.transitionJob({
				jobId: capabilityJobId(job),
				from: "running",
				to: "completed",
				detail: "Recovered Hermes answer delivered",
			});
		}
	}
}

async function recoverReplyOnly(
	job: DiscordJob,
	deps: DiscordJobProcessorDeps,
	record: { replyContent?: string; replyContentHash?: string },
): Promise<void> {
	if (!record.replyContent) {
		throw new DiscordManualInterventionError(
			`Discord interaction ${job.interactionId} has no persisted reply content`,
		);
	}
	try {
		await deliverReply(
			job,
			deps,
			record.replyContent,
			await buildDiscordReplyOptions(job, deps, record.replyContent),
		);
	} catch (error) {
		throw new DiscordManualInterventionError(describeError(error));
	}
	await terminalUpdate(job, deps.discordUpdateStore, "complete", {
		replyContentHash:
			record.replyContentHash ??
			(await hashCanonicalInput(record.replyContent)),
	});
}

async function sendReply(
	job: DiscordJob,
	deps: DiscordJobProcessorDeps,
	answer: string,
	options?: DiscordReplyOptions,
): Promise<void> {
	await beginReply(job, deps.discordUpdateStore, answer);
	try {
		await deliverReply(job, deps, answer, options);
	} catch (error) {
		throw new DiscordManualInterventionError(describeError(error));
	}
}

async function deliverReply(
	job: DiscordJob,
	deps: DiscordJobProcessorDeps,
	text: string,
	options?: DiscordReplyOptions,
): Promise<void> {
	const generatedAttachment = options
		? undefined
		: buildDiscordArtifactAttachment(job, text);
	const replyOptions =
		options ??
		(generatedAttachment ? { attachment: generatedAttachment } : undefined);
	if (job.delivery === "channel") {
		if (!job.channelId) {
			throw new Error("Discord channel delivery requires channelId");
		}
		if (job.progressMessageId && deps.discordReplyClient.editChannelMessage) {
			await deps.discordReplyClient.editChannelMessage(
				job.channelId,
				job.progressMessageId,
				text,
				replyOptions,
			);
			return;
		}
		await deps.discordReplyClient.replyToChannel(
			job.channelId,
			text,
			job.sourceMessageId,
			replyOptions,
		);
		return;
	}
	if (!job.interactionToken) {
		throw new Error("Discord interaction delivery requires interactionToken");
	}
	await deps.discordReplyClient.reply(
		job.applicationId,
		job.interactionToken,
		text,
		replyOptions,
	);
}

async function buildDiscordReplyOptions(
	job: DiscordJob,
	deps: DiscordJobProcessorDeps,
	text: string,
	attachmentOverride?: DiscordReplyAttachment,
): Promise<DiscordReplyOptions | undefined> {
	const hilAttachment = buildDiscordArtifactAttachment(job, text);
	const attachment = attachmentOverride ?? hilAttachment;
	const attachments =
		attachmentOverride && hilAttachment
			? [attachmentOverride, hilAttachment]
			: undefined;
	if (!isApprovalRequest(job)) {
		return attachment
			? { attachment, ...(attachments ? { attachments } : {}) }
			: undefined;
	}
	if (!deps.capabilityJobStore) {
		throw new Error("Capability approval state is unavailable");
	}
	const approvalInput = job.deployPlan
		? {
				approvalId: `approval_${job.deployPlan.id}`,
				action: `deploy ${job.deployPlan.repository}@${job.deployPlan.commitSha} to ${job.deployPlan.targetId}`,
				actionDigest: job.deployPlan.digest,
				ttlSeconds: Math.max(
					60,
					Math.floor(
						(Date.parse(job.deployPlan.expiresAt) -
							Date.parse(job.deployPlan.createdAt)) /
							1_000,
					),
				),
				approveLabel: "Approve deploy",
			}
		: job.databasePlan
			? {
					approvalId: `approval_db_${job.interactionId}`,
					action: `run read-only database query ${job.databasePlan.policyPlan.fingerprint}`,
					actionDigest: job.databasePlan.planDigest,
					ttlSeconds: 15 * 60,
					approveLabel: "Approve query",
				}
			: undefined;
	if (!approvalInput) {
		throw new Error("Immutable approval plan is unavailable");
	}
	const approval = await deps.capabilityJobStore.requestApproval({
		approvalId: approvalInput.approvalId,
		jobId: capabilityJobId(job),
		userId: job.userId,
		guildId: job.guildId,
		action: approvalInput.action,
		actionDigest: approvalInput.actionDigest,
		ttlSeconds: approvalInput.ttlSeconds,
	});
	return {
		...(attachment ? { attachment } : {}),
		...(attachments ? { attachments } : {}),
		components: [
			{
				type: 1,
				components: [
					{
						type: 2,
						style: 3,
						label: approvalInput.approveLabel,
						custom_id: `cap:approve:${approval.approvalId}`,
					},
					{
						type: 2,
						style: 4,
						label: "Reject",
						custom_id: `cap:reject:${approval.approvalId}`,
					},
				],
			},
		],
	};
}

async function captureArtifact(
	job: DiscordJob,
	deps: DiscordJobProcessorDeps,
	sessionId: string,
	route: "legacy" | "hermes",
): Promise<DiscordJobAnswer> {
	if (job.capability?.kind !== "artifact_request") {
		throw new Error("Artifact capability payload is missing");
	}
	const capability = job.capability;
	if (capability.artifactKind !== "screenshot") {
		const generated = await generateArtifactContent(
			capability,
			deps,
			sessionId,
			route,
		);
		const artifactKind =
			capability.artifactKind === "diagram"
				? "markdown"
				: capability.artifactKind;
		const content =
			capability.artifactKind === "json" || capability.artifactKind === "csv"
				? parseGeneratedJson(generated, capability.artifactKind === "csv")
				: generated;
		const artifact = await createArtifact({
			kind: artifactKind,
			name: `${capability.artifactKind}-${job.interactionId}`,
			content,
		});
		return {
			text: `Created \`${capability.artifactKind}\` artifact.`,
			attachment: {
				filename: artifact.filename,
				contentType: artifact.contentType,
				data: artifact.data,
			},
		};
	}
	const config = deps.config.capabilities;
	if (
		!config?.artifactRendererUrl ||
		!config.artifactRendererToken ||
		!config.artifactScreenshotTargetsJson
	) {
		return {
			text: "Screenshot capture is disabled until ARTIFACT_RENDERER_* and ARTIFACT_SCREENSHOT_TARGETS_JSON are configured. No external page was opened.",
		};
	}
	const artifact = await createArtifact({
		kind: "screenshot",
		name: `${job.capability.targetId}-${job.interactionId}`,
		targetId: job.capability.targetId,
		renderer: {
			endpoint: config.artifactRendererUrl,
			token: config.artifactRendererToken,
			targets: parseScreenshotTargets(config.artifactScreenshotTargetsJson),
		},
		fetch: deps.fetch,
	});
	return {
		text: `Captured allowlisted artifact target \`${job.capability.targetId}\`.`,
		attachment: {
			filename: artifact.filename,
			contentType: artifact.contentType,
			data: artifact.data,
		},
	};
}

async function generateArtifactContent(
	capability: Extract<DiscordCapabilityPayload, { kind: "artifact_request" }>,
	deps: DiscordJobProcessorDeps,
	sessionId: string,
	route: "legacy" | "hermes",
): Promise<string> {
	const formatInstruction =
		capability.artifactKind === "json"
			? "Return only valid JSON with no Markdown fence or commentary."
			: capability.artifactKind === "csv"
				? "Return only a valid JSON array of flat objects. It will be converted to CSV after validation."
				: capability.artifactKind === "diagram"
					? "Return a concise Markdown document containing one valid Mermaid code block and a short legend."
					: "Return a concise Markdown document.";
	const prompt = [
		`Create a ${capability.artifactKind} artifact for this request:`,
		capability.request,
		"",
		formatInstruction,
		"Do not include secrets, credentials, unmasked personal data, or claims unsupported by the request.",
	].join("\n");
	if (route === "hermes") {
		if (!deps.hermesClient) {
			throw new Error("Hermes client is required for artifact generation");
		}
		return (
			await deps.hermesClient.chat({
				sessionId,
				source: "discord",
				input: prompt,
			})
		).text;
	}
	return deps.orchestrator.answer(prompt, []);
}

function parseGeneratedJson(value: string, requireRows: boolean): unknown {
	const trimmed = value.trim();
	const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	let parsed: unknown;
	try {
		parsed = JSON.parse(fenced?.[1] ?? trimmed);
	} catch {
		throw new Error("Generated artifact was not valid JSON");
	}
	if (
		requireRows &&
		(!Array.isArray(parsed) ||
			parsed.some(
				(row) => !row || typeof row !== "object" || Array.isArray(row),
			))
	) {
		throw new Error("Generated CSV artifact must be a JSON array of objects");
	}
	return parsed;
}

async function executeDeploy(
	job: DiscordJob,
	deps: DiscordJobProcessorDeps,
): Promise<DiscordJobAnswer> {
	if (
		!job.deployPlan ||
		!job.deployApprovalId ||
		!job.approvedBy ||
		!deps.capabilityJobStore
	) {
		throw new Error("Approved deploy context is incomplete");
	}
	const approval = await deps.capabilityJobStore.getApproval(
		job.deployApprovalId,
	);
	if (
		!approval ||
		approval.status !== "approved" ||
		approval.jobId !== capabilityJobId(job) ||
		approval.userId !== job.approvedBy ||
		approval.actionDigest !== job.deployPlan.digest
	) {
		throw new Error("Deploy approval is missing, expired, or does not match");
	}
	const config = deps.config.capabilities;
	if (!config?.deployTargetsJson || !config.deployExecutorToken) {
		throw new Error("Deploy executor is not configured");
	}
	let result: DeployExecutionResult;
	try {
		result = await executeApprovedDeploy({
			plan: job.deployPlan,
			targets: parseDeployTargets(config.deployTargetsJson),
			approvedBy: job.approvedBy,
			approvedDigest: approval.actionDigest,
			executorToken: config.deployExecutorToken,
			fetch: deps.fetch,
		});
	} catch (error) {
		if (error instanceof DeployExecutionUncertainError) {
			throw new DiscordManualInterventionError(
				error.message,
				[
					"**Deploy execution status is uncertain.**",
					`Request ID: \`${capabilityJobId(job)}\``,
					`Plan ID: \`${job.deployPlan.id}\``,
					"Do not approve or submit a new deploy blindly. Check the deploy executor record/status using this Plan ID first.",
				].join("\n"),
			);
		}
		throw error;
	}
	const rollbackGuidance = isRecord(result.artifact.rollbackGuidance)
		? result.artifact.rollbackGuidance
		: undefined;
	return {
		text: [
			result.status === "succeeded"
				? `Deploy succeeded for **${job.deployPlan.targetName}**.`
				: `Deploy failed for **${job.deployPlan.targetName}**.`,
			`Execution ID: \`${result.executionId}\``,
			`Commit: \`${job.deployPlan.commitSha}\``,
			result.replayed
				? "Executor returned the existing idempotent result."
				: undefined,
			result.status === "failed"
				? "No automatic rollback was run. A separate approval is required."
				: undefined,
			typeof rollbackGuidance?.reason === "string"
				? `Failure: ${rollbackGuidance.reason}`
				: undefined,
			result.statusUrl ? `Status: ${result.statusUrl}` : undefined,
		]
			.filter(Boolean)
			.join("\n"),
		attachment: {
			filename: safeArtifactFilename({
				title: `deploy-${result.status}-${job.deployPlan.targetId}`,
				capability: "deploy",
				extension: "json",
			}),
			contentType: "application/json;charset=utf-8",
			data: `${JSON.stringify(
				{
					version: "deploy-hil-artifact/v1",
					artifactId: result.executionId,
					requestId: capabilityJobId(job),
					planId: job.deployPlan.id,
					planDigest: job.deployPlan.digest,
					target: job.deployPlan.targetId,
					commitSha: job.deployPlan.commitSha,
					approvedBy: job.approvedBy,
					status: result.status,
					replayed: result.replayed,
					executorArtifact: result.artifact,
					rollbackRequiresSeparateApproval:
						job.deployPlan.rollback.requiresSeparateApproval,
				},
				null,
				2,
			)}\n`,
		},
		capabilityStatus: result.status === "failed" ? "failed" : "completed",
	};
}

async function executeDatabasePlan(
	job: DiscordJob,
	deps: DiscordJobProcessorDeps,
): Promise<DiscordJobAnswer> {
	if (
		!job.databasePlan ||
		!job.databaseApprovalId ||
		!job.approvedBy ||
		!deps.capabilityJobStore ||
		!deps.databaseReadClient ||
		!deps.databasePlanningContext
	) {
		throw new Error("Approved database query context is incomplete");
	}
	const approval = await deps.capabilityJobStore.getApproval(
		job.databaseApprovalId,
	);
	if (
		!approval ||
		approval.status !== "approved" ||
		approval.jobId !== capabilityJobId(job) ||
		approval.userId !== job.approvedBy ||
		job.databasePlan.requestedBy !== job.approvedBy ||
		approval.actionDigest !== job.databasePlan.planDigest ||
		job.databasePlan.approval.operationDigest !== job.databasePlan.planDigest
	) {
		throw new Error(
			"Database query approval is missing, expired, or does not match",
		);
	}
	if (
		!(await verifyNaturalLanguageDatabaseQueryPlan(
			job.databasePlan,
			deps.databasePlanningContext,
		))
	) {
		throw new Error("Database query plan failed immutable digest verification");
	}
	const result = await deps.databaseReadClient.query({
		sql: job.databasePlan.sql,
		params: job.databasePlan.params,
		requestId: capabilityJobId(job),
		requestedBy: job.approvedBy,
	});
	return {
		text: formatDatabaseResult(result),
		attachment: buildDatabaseResultAttachment(job, result),
	};
}

async function startTypingHeartbeat(
	job: DiscordJob,
	client: DiscordReplyClient,
): Promise<() => void> {
	if (job.delivery !== "channel" || !job.channelId) {
		return () => undefined;
	}
	const channelId = job.channelId;
	const sendTyping = async () => {
		try {
			await client.sendTyping(channelId);
		} catch (error) {
			console.warn(
				JSON.stringify({
					message: "discord typing indicator failed",
					channelId,
					error: describeError(error),
				}),
			);
		}
	};
	await sendTyping();
	const timer = setInterval(() => {
		void sendTyping();
	}, 8_000);
	return () => clearInterval(timer);
}

async function updateInteractionProgress(
	job: DiscordJob,
	client: DiscordReplyClient,
): Promise<void> {
	if (
		job.delivery === "channel" ||
		!job.interactionToken ||
		!client.updateInteractionProgress
	) {
		return;
	}
	try {
		await client.updateInteractionProgress(
			job.applicationId,
			job.interactionToken,
			job.capability
				? `กำลังทำงาน \`${capabilityName(job)}\`… Request ID: \`${capabilityJobId(job)}\``
				: "กำลังประมวลผล…",
		);
	} catch (error) {
		console.warn(
			JSON.stringify({
				message: "discord interaction progress update failed",
				interactionId: job.interactionId,
				error: describeError(error),
			}),
		);
	}
}

async function isCapabilityJobCancelled(
	job: DiscordJob,
	deps: DiscordJobProcessorDeps,
): Promise<boolean> {
	if (!job.capability || !deps.capabilityJobStore) return false;
	return (
		(await deps.capabilityJobStore.getJob(capabilityJobId(job)))?.status ===
		"cancelled"
	);
}

async function beginReply(
	job: DiscordJob,
	store: TelegramUpdateStore,
	text: string,
): Promise<void> {
	const result = await store.beginReply({
		providerSessionId: job.providerSessionId ?? discordSessionId(job),
		idempotencyKey:
			job.idempotencyKey ?? `discord:interaction:${job.interactionId}`,
		replyContentHash: await hashCanonicalInput(text),
		replyContent: text,
	});
	if (result.kind !== "ready") {
		throw new DiscordManualInterventionError(
			`Discord reply checkpoint was not ready for ${job.interactionId}`,
		);
	}
}

async function terminalUpdate(
	job: DiscordJob,
	store: TelegramUpdateStore,
	method: "complete" | "fail" | "markUncertain",
	extra: {
		terminalReason?: string;
		replyContentHash?: string;
		recoveredAssistantMessageId?: string;
		recoveredAssistantContentHash?: string;
	} = {},
): Promise<void> {
	await store[method]({
		providerSessionId: job.providerSessionId ?? discordSessionId(job),
		idempotencyKey:
			job.idempotencyKey ?? `discord:interaction:${job.interactionId}`,
		...extra,
	});
}

function hermesInput(job: DiscordJob): string {
	if (!job.repository || !job.branch || !job.question) {
		if (job.capability?.kind === "database_query") {
			return `Database request: ${job.question ?? job.text}

Safety rules:
- Do not execute live SQL unless an explicit read-only database tool is configured.
- If no database tool is available, answer from repository schema, migrations, ORM models, and configuration only.
- Include the exact files or missing configuration required before a live query can run.`;
		}
		if (job.capability?.kind === "artifact_request") {
			return `Artifact request: ${job.question ?? job.text}

Create a concise HIL artifact with objective, evidence, findings, risks, human checks, and recommended next action. If a diagram is requested, return a copyable text diagram or Mermaid block.`;
		}
		if (job.capability?.kind === "deploy_request") {
			return `Deploy request: ${job.question ?? job.text}

Prepare a deployment plan only. Do not deploy automatically. Include target, commit/ref, checks to run, risk summary, rollback path, and the exact approval needed before any mutation.`;
		}
		return job.text;
	}
	if (job.capability?.kind === "risk_assessment") {
		const evidenceScope = job.capability.pullRequest
			? `First call get_pull_request with number ${job.capability.pullRequest}.`
			: job.capability.baseRef
				? `First call compare_refs with base ${job.capability.baseRef} and head ${job.branch}.`
				: "No PR or base ref was supplied. State this evidence gap and do not invent a diff.";
		return formatHermesSourceInput({
			repository: job.repository,
			branch: job.branch,
			question: `Risk assessment request: ${job.capability.change}

${evidenceScope}

Please inspect the implementation/deployment impact. Include blast radius, side effects, files/functions affected, where humans should test, and a concise approval recommendation.`,
		});
	}
	if (job.capability?.kind === "deploy_request") {
		return formatHermesSourceInput({
			repository: job.repository,
			branch: job.branch,
			question: `Deploy request: ${job.capability.repository}@${job.capability.commitSha} to ${job.capability.target}

${job.capability.context ?? ""}

Prepare a deployment plan only. Do not deploy automatically. Include target, commit/ref, checks to run, risk summary, rollback path, and the exact approval needed before any mutation.`,
		});
	}
	return formatHermesSourceInput({
		repository: job.repository,
		branch: job.branch,
		question: job.question,
	});
}

function buildDiscordArtifactAttachment(
	job: DiscordJob,
	answer: string,
): DiscordReplyAttachment | undefined {
	if (job.action !== "chat") {
		return undefined;
	}
	if (
		!job.repository &&
		!["database_query", "artifact_request", "deploy_request"].includes(
			job.capability?.kind ?? "",
		)
	) {
		return undefined;
	}
	const capability = capabilityName(job);
	const createdAt = new Date().toISOString();
	const artifact: HilArtifactV1 = {
		version: hilArtifactVersion,
		artifactId: `artifact_${job.interactionId}`,
		title:
			capability === "risk-assessment"
				? `Risk Assessment: ${job.repository}@${job.branch}`
				: capability === "ask-database"
					? "Database Question"
					: capability === "ask-artifact"
						? "Requested Artifact"
						: capability === "deploy"
							? "Deployment Plan"
							: `Code Investigation: ${job.repository}@${job.branch}`,
		capability,
		status: "completed",
		objective: job.question ?? job.text,
		source: {
			kind:
				capability === "ask-database"
					? "database"
					: capability === "deploy"
						? "deployment"
						: "code",
			...(job.repository ? { repository: job.repository } : {}),
			...(job.branch ? { branch: job.branch } : {}),
		},
		evidence: [
			{
				label: "Hermes response",
				summary:
					answer.length > 500 ? `${answer.slice(0, 497).trimEnd()}...` : answer,
				source: "hermes",
			},
		],
		findings: [
			{
				title: "Agent summary",
				summary: answer,
				severity: capability === "risk-assessment" ? "medium" : "info",
			},
		],
		risks:
			capability === "risk-assessment"
				? [
						{
							title: "Requires human verification",
							impact:
								"AI assessment may miss runtime, infrastructure, or production-only behavior.",
							likelihood: "medium",
							mitigation:
								"Run the human test plan and review affected files before approval.",
						},
					]
				: capability === "ask-database"
					? [
							{
								title: "Bounded read-only result",
								impact:
									"The result may be truncated, masked, or stale by the time a human acts on it.",
								likelihood: "medium",
								mitigation:
									"Verify datasource, fingerprint, duration, row count, truncation, and masked fields in the attached result artifact.",
							},
						]
					: capability === "deploy"
						? [
								{
									title: "Mutation requires approval",
									impact:
										"Deployment changes external state and may affect availability.",
									likelihood: "medium",
									mitigation:
										"Require explicit approval, health checks, and rollback path before deploy.",
								},
							]
						: [],
		humanActions:
			capability === "risk-assessment"
				? [
						{
							label: "Verify blast radius",
							description:
								"Confirm affected routes, services, jobs, database writes, and external integrations.",
							required: true,
						},
						{
							label: "Run targeted tests",
							description:
								"Execute the manual or automated checks recommended by the agent.",
							required: true,
						},
					]
				: capability === "ask-database"
					? [
							{
								label: "Review query provenance",
								description:
									"Confirm datasource, SQL fingerprint, allowlisted tables, truncation, and PII masking before using the result.",
								required: true,
							},
						]
					: capability === "deploy"
						? [
								{
									label: "Approve deployment target",
									description:
										"Confirm target environment, ref, checks, and rollback path before deployment.",
									required: true,
								},
							]
						: [
								{
									label: "Review cited files",
									description:
										"Open the files and paths cited in the response before relying on the conclusion.",
									required: false,
								},
							],
		recommendedAction:
			capability === "risk-assessment"
				? "Approve only after the human verification actions pass."
				: capability === "ask-database"
					? "Use the attached result only after reviewing its bounded-query provenance and limitations."
					: capability === "deploy"
						? "Treat this as a deployment plan, not deployment approval."
						: "Use this artifact as an investigation handoff with cited evidence.",
		metadata: {
			createdAt,
			correlationId: job.interactionId,
			inputs: {
				interactionId: job.interactionId,
				delivery: job.delivery ?? "interaction",
			},
		},
	};
	return {
		filename: safeArtifactFilename({
			title: artifact.title,
			capability: artifact.capability,
			createdAt,
			extension: "md",
		}),
		contentType: "text/markdown;charset=utf-8",
		data: renderHilArtifactMarkdown(artifact),
	};
}

function capabilityName(job: DiscordJob): string {
	switch (job.capability?.kind) {
		case "code_investigation":
			return "ask-code";
		case "risk_assessment":
			return "risk-assessment";
		case "database_query":
			return "ask-database";
		case "artifact_request":
			return "ask-artifact";
		case "deploy_request":
			return "deploy";
		case "status":
			return "status";
		case "skills":
			return "skills";
		default:
			return job.repository ? "ask-code" : "chat";
	}
}

async function ensureCapabilityJob(
	job: DiscordJob,
	deps: DiscordJobProcessorDeps,
): Promise<void> {
	if (!job.capability || !deps.capabilityJobStore) return;
	if (isApprovedExecution(job)) return;
	await deps.capabilityJobStore.createJob({
		jobId: capabilityJobId(job),
		capability: job.capability.kind,
		userId: job.userId,
		guildId: job.guildId,
		channelId: job.channelId,
		actionDigest:
			job.deployPlan?.digest ??
			job.databasePlan?.planDigest ??
			job.canonicalInputHash ??
			(await hashCanonicalInput(job.text)),
		objective: job.question ?? job.text,
		metadata: {
			delivery: job.delivery ?? "interaction",
			...(job.repository ? { repository: job.repository } : {}),
			...(job.branch ? { branch: job.branch } : {}),
			...(job.deployPlan ? { deployPlan: JSON.stringify(job.deployPlan) } : {}),
			...(job.databasePlan
				? { databasePlan: JSON.stringify(job.databasePlan) }
				: {}),
		},
	});
}

async function failCapabilityJob(
	job: DiscordJob,
	deps: DiscordJobProcessorDeps,
	reason: string,
): Promise<void> {
	if (!job.capability || !deps.capabilityJobStore) return;
	const current = await deps.capabilityJobStore.getJob(capabilityJobId(job));
	if (
		!current ||
		["completed", "failed", "cancelled"].includes(current.status)
	) {
		return;
	}
	await deps.capabilityJobStore.transitionJob({
		jobId: capabilityJobId(job),
		from: ["queued", "running", "waiting_approval"],
		to: "failed",
		detail: reason.slice(0, 500),
	});
}

function capabilityJobId(job: DiscordJob): string {
	return job.capabilityJobId ?? job.interactionId;
}

function isApprovalRequest(job: DiscordJob): boolean {
	return (
		job.action === "chat" &&
		((job.capability?.kind === "deploy_request" && Boolean(job.deployPlan)) ||
			(job.capability?.kind === "database_query" && Boolean(job.databasePlan)))
	);
}

function isApprovedExecution(job: DiscordJob): boolean {
	return job.action === "deploy_execute" || job.action === "db_execute";
}

function formatDatabasePlan(plan: NaturalLanguageDbQueryPlan): string {
	return [
		"**Read-only database query proposal**",
		`Datasource: \`${plan.policyPlan.datasource}\``,
		`Tables: ${plan.referencedTables.map((table) => `\`${table}\``).join(", ")}`,
		`Limits: ${plan.policyPlan.maxRows} rows, ${plan.policyPlan.maxBytes} bytes, ${plan.policyPlan.timeoutMs} ms`,
		`Query fingerprint: \`${plan.policyPlan.fingerprint}\``,
		"```sql",
		plan.sql,
		"```",
		...plan.assumptions.map((assumption) => `Assumption: ${assumption}`),
		...plan.warnings.map((warning) => `Warning: ${warning}`),
		"No query has run. Approve this exact immutable plan to execute it once.",
	].join("\n");
}

function formatDatabaseResult(result: DatabaseReadResult): string {
	return [
		"**Read-only database result**",
		`Datasource: \`${result.datasource}\``,
		`Rows: ${result.rowCount}${result.truncated ? " (truncated)" : ""}`,
		`Duration: ${result.durationMs} ms`,
		`Query fingerprint: \`${result.audit.fingerprint}\``,
		"Result rows and query provenance are attached as a JSON HIL artifact.",
	].join("\n");
}

function buildDatabaseResultAttachment(
	job: DiscordJob,
	result: DatabaseReadResult,
): DiscordReplyAttachment {
	const createdAt = new Date().toISOString();
	return {
		filename: safeArtifactFilename({
			title: `database-result-${result.audit.fingerprint}`,
			capability: "ask-database",
			createdAt,
			extension: "json",
		}),
		contentType: "application/json;charset=utf-8",
		data: `${JSON.stringify(
			{
				version: "db-query-artifact/v1",
				artifactId: `artifact_${job.interactionId}`,
				capability: "ask-database",
				status: "completed",
				createdAt,
				requestId: capabilityJobId(job),
				datasource: result.datasource,
				query: {
					sql: result.sql,
					fingerprint: result.audit.fingerprint,
					referencedTables: result.audit.referencedTables,
					limits: result.audit.limits,
				},
				durationMs: result.durationMs,
				columns: result.columns,
				rowCount: result.rowCount,
				truncated: result.truncated,
				rows: result.rows,
				humanActions: [
					"Confirm the datasource and query fingerprint before sharing the result.",
					"Review masked fields and truncation before using this artifact for a decision.",
				],
			},
			null,
			2,
		)}\n`,
	};
}

function selectDiscordRuntime(
	deps: DiscordJobProcessorDeps,
): "legacy" | "hermes" {
	return deps.config.runtime.mode === "hermes" && deps.hermesClient
		? "hermes"
		: "legacy";
}

function isRetryableJobError(error: unknown): boolean {
	if (error instanceof DiscordManualInterventionError) {
		return error.retryable;
	}
	if (error instanceof DiscordApiError) {
		return error.retryable;
	}
	if (error instanceof ResponsesApiError || error instanceof HermesApiError) {
		return error.retryable;
	}
	return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : "Unknown error";
}
