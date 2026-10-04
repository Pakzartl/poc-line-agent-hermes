import { ResponsesApiError } from "../agent/llm-client";
import type { AgentOrchestrator } from "../agent/orchestrator";
import type { AppConfig } from "../config";
import {
	findRecoveredAssistantMessage,
	HermesApiError,
	type HermesClient,
} from "../hermes/client";
import type { SessionMemoryStore } from "../memory/types";
import type { TelegramReplyClient } from "./reply";
import { selectTelegramAgentRoute } from "./routing";
import { formatHermesSourceInput } from "./source-scope";
import type { TelegramUpdateStore } from "./update-store";

export type TelegramJob = {
	updateId?: string;
	idempotencyKey?: string;
	providerSessionId?: string;
	sessionSequence?: number;
	generation?: string;
	canonicalInputHash?: string;
	chatId: number | string;
	messageId?: number;
	userId?: string;
	text: string;
	repository: string;
	branch: string;
	question: string;
};

export type TelegramJobQueue = {
	send(job: TelegramJob): Promise<void>;
};

export type TelegramJobProcessorDeps = {
	config: AppConfig;
	orchestrator: AgentOrchestrator;
	hermesClient?: HermesClient;
	telegramReplyClient: TelegramReplyClient;
	telegramUpdateStore: TelegramUpdateStore;
	memoryStore: SessionMemoryStore;
};

export function telegramSessionId(chatId: number | string): string {
	return `telegram:chat:source-v4:${chatId}`;
}

function isRetryableJobError(error: unknown): boolean {
	if (error instanceof TelegramManualInterventionError) {
		return error.retryable;
	}
	if (error instanceof ResponsesApiError || error instanceof HermesApiError) {
		return error.retryable;
	}
	return true;
}

type TelegramQueueMessage = {
	body: TelegramJob;
	attempts: number;
	ack(): void;
	retry(options?: { delaySeconds?: number }): void;
};

const maxDeliveryAttempts = 3;
const temporaryAiFailureMessage =
	"ระบบ AI มีคำขอหนาแน่นชั่วคราว กรุณาลองใหม่อีกครั้งในอีกสักครู่ครับ";
const permanentAiFailureMessage =
	"ระบบ AI ไม่พร้อมใช้งาน กรุณาติดต่อผู้ดูแลระบบเพื่อตรวจสอบโควตาหรือการตั้งค่าครับ";
const unexpectedFailureMessage =
	"เกิดข้อผิดพลาดระหว่างประมวลผล กรุณาลองส่งคำขออีกครั้งครับ";
const deferredQueueDelaySeconds = 5;
const typingRefreshIntervalMs = 4_000;

class TelegramManualInterventionError extends Error {
	readonly retryable = true;

	constructor(message: string) {
		super(message);
		this.name = "TelegramManualInterventionError";
	}
}

export function createInlineTelegramJobQueue(
	deps: TelegramJobProcessorDeps,
): TelegramJobQueue {
	return {
		send: async (job) => {
			await processTelegramJob(job, deps);
		},
	};
}

export async function processTelegramQueueMessage(
	message: TelegramQueueMessage,
	deps: TelegramJobProcessorDeps,
): Promise<void> {
	try {
		const result = await processTelegramJob(message.body, deps);
		if (result === "deferred") {
			message.retry({ delaySeconds: deferredQueueDelaySeconds });
			return;
		}
		message.ack();
	} catch (error) {
		const retryable = isRetryableJobError(error);
		if (retryable && message.attempts < maxDeliveryAttempts) {
			const delaySeconds = 30 * 2 ** Math.max(0, message.attempts - 1);
			console.warn(
				JSON.stringify({
					message: "telegram agent job retry",
					updateId: message.body.updateId ?? "unknown",
					attempt: message.attempts,
					delaySeconds,
					error: describeError(error),
				}),
			);
			message.retry({ delaySeconds });
			return;
		}

		console.error(
			JSON.stringify({
				message: "telegram agent job failed",
				updateId: message.body.updateId ?? "unknown",
				attempt: message.attempts,
				error: describeError(error),
			}),
		);
		if (error instanceof TelegramManualInterventionError) {
			await terminalUpdate(
				message.body,
				deps.telegramUpdateStore,
				"markUncertain",
				{ terminalReason: describeError(error) },
			);
			message.ack();
			return;
		}
		const failureText = failureMessage(error);
		await beginReply(message.body, deps.telegramUpdateStore, failureText);
		await deps.telegramReplyClient.reply(
			message.body.chatId,
			failureText,
			message.body.messageId,
		);
		await terminalUpdate(message.body, deps.telegramUpdateStore, "fail", {
			terminalReason: describeError(error),
			replyContentHash: await hashCanonicalInput(failureText),
		});
		message.ack();
	}
}

async function processTelegramJob(
	job: TelegramJob,
	deps: TelegramJobProcessorDeps,
): Promise<"processed" | "deferred"> {
	const typing = await startTelegramTyping(job, deps.telegramReplyClient);
	try {
		return await processTelegramJobWithTyping(job, deps);
	} finally {
		await typing.stop();
	}
}

async function processTelegramJobWithTyping(
	job: TelegramJob,
	deps: TelegramJobProcessorDeps,
): Promise<"processed" | "deferred"> {
	const sessionId = telegramSessionId(job.chatId);
	const route = selectTelegramRuntime(job, deps);
	const baseline =
		route === "hermes"
			? await deps.hermesClient?.lastMessageMarker(sessionId)
			: undefined;
	const lease = await deps.telegramUpdateStore.dispatchLease({
		providerSessionId: job.providerSessionId ?? sessionId,
		idempotencyKey: job.idempotencyKey ?? fallbackIdempotencyKey(job),
		canonicalInputHash:
			job.canonicalInputHash ?? (await hashCanonicalInput(job.text)),
		sessionSequence: job.sessionSequence,
		generation: job.generation,
		updateId: job.updateId,
		...(job.messageId !== undefined
			? { messageId: String(job.messageId) }
			: {}),
		baselineLastHermesMessageId: baseline?.id,
		baselineLastHermesMessageTimestamp: baseline?.timestamp,
	});
	if (lease.kind === "deferred") {
		return "deferred";
	}
	if (lease.kind === "duplicate") {
		if (lease.record?.status === "replying") {
			await recoverReplyOnlyTelegramJob(job, deps, lease.record);
			return "processed";
		}
		if (lease.record?.status === "uncertain" && !lease.record.terminalReason) {
			await terminalUpdate(job, deps.telegramUpdateStore, "markUncertain", {
				terminalReason: `Unresolved Hermes dispatch released for ${lease.record.key}`,
			});
			return "processed";
		}
		return "processed";
	}
	if (lease.kind === "recovery") {
		await recoverTelegramJob(job, deps, lease.record);
		return "processed";
	}
	let answer: string;
	if (route === "hermes") {
		const hermesClient = deps.hermesClient;
		if (!hermesClient) {
			throw new Error("Hermes client is required for Hermes runtime");
		}
		const result = await hermesClient.chat({
			sessionId,
			source: "telegram",
			input: hermesInput(job),
		});
		answer = result.text;
	} else {
		try {
			answer = await answerWithLegacyRuntime(job, deps, sessionId);
		} catch (error) {
			if (isLegacyPreReplyRetryableError(error)) {
				await deps.telegramUpdateStore.retryPreReply({
					providerSessionId: job.providerSessionId ?? sessionId,
					idempotencyKey: job.idempotencyKey ?? fallbackIdempotencyKey(job),
				});
			}
			throw error;
		}
	}
	await beginReply(job, deps.telegramUpdateStore, answer);
	try {
		await deps.telegramReplyClient.reply(job.chatId, answer, job.messageId);
	} catch (error) {
		throw new TelegramManualInterventionError(describeError(error));
	}
	if (route === "legacy") {
		await appendLegacyMemory(job, deps, sessionId, answer);
	}
	await terminalUpdate(job, deps.telegramUpdateStore, "complete", {
		replyContentHash: await hashCanonicalInput(answer),
	});
	return "processed";
}

type TelegramTypingIndicator = {
	stop(): Promise<void>;
};

async function startTelegramTyping(
	job: TelegramJob,
	replyClient: TelegramReplyClient,
): Promise<TelegramTypingIndicator> {
	if (!replyClient.sendChatAction) {
		return { stop: async () => undefined };
	}

	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let inFlight: Promise<void> | undefined;
	const sendTyping = async () => {
		try {
			await replyClient.sendChatAction?.(job.chatId, "typing");
		} catch (error) {
			console.warn(
				JSON.stringify({
					message: "telegram typing indicator failed",
					updateId: job.updateId ?? "unknown",
					error: describeError(error),
				}),
			);
		}
	};
	const schedule = () => {
		timer = setTimeout(() => {
			if (stopped) {
				return;
			}
			inFlight = sendTyping().finally(() => {
				inFlight = undefined;
				if (!stopped) {
					schedule();
				}
			});
		}, typingRefreshIntervalMs);
	};

	await sendTyping();
	schedule();
	return {
		async stop() {
			stopped = true;
			if (timer) {
				clearTimeout(timer);
			}
			await inFlight;
		},
	};
}

async function answerWithLegacyRuntime(
	job: TelegramJob,
	deps: TelegramJobProcessorDeps,
	sessionId: string,
): Promise<string> {
	const history = await deps.memoryStore.read(sessionId);
	return deps.orchestrator.answer(job.text, history);
}

async function appendLegacyMemory(
	job: TelegramJob,
	deps: TelegramJobProcessorDeps,
	sessionId: string,
	answer: string,
): Promise<void> {
	try {
		await deps.memoryStore.append(sessionId, [
			{ role: "user", content: job.text },
			{ role: "assistant", content: answer },
		]);
	} catch (error) {
		console.error(
			JSON.stringify({
				message: "telegram memory append failed",
				updateId: job.updateId ?? "unknown",
				error: describeError(error),
			}),
		);
	}
}

async function recoverTelegramJob(
	job: TelegramJob,
	deps: TelegramJobProcessorDeps,
	record: {
		baselineLastHermesMessageId?: string;
		baselineLastHermesMessageTimestamp?: string;
	},
): Promise<void> {
	if (!deps.hermesClient || !shouldUseHermes(job, deps.config)) {
		throw new Error("Hermes recovery is unavailable for this routed job");
	}
	const sessionId = telegramSessionId(job.chatId);
	const messages = await deps.hermesClient.listMessages(sessionId);
	const recovered = findRecoveredAssistantMessage({
		messages,
		userInput: hermesInput(job),
		baseline: {
			id: record.baselineLastHermesMessageId,
			timestamp: record.baselineLastHermesMessageTimestamp,
		},
	});
	if (!recovered) {
		throw new Error("Hermes answer is not available for recovery yet");
	}
	await beginReply(job, deps.telegramUpdateStore, recovered.content);
	try {
		await deps.telegramReplyClient.reply(
			job.chatId,
			recovered.content,
			job.messageId,
		);
	} catch (error) {
		throw new TelegramManualInterventionError(describeError(error));
	}
	await terminalUpdate(job, deps.telegramUpdateStore, "complete", {
		recoveredAssistantMessageId: recovered.id,
		recoveredAssistantContentHash: await hashCanonicalInput(recovered.content),
		replyContentHash: await hashCanonicalInput(recovered.content),
	});
}

function hermesInput(job: TelegramJob): string {
	if (!job.repository || !job.branch) {
		return job.question;
	}
	return formatHermesSourceInput({
		repository: job.repository,
		branch: job.branch,
		question: job.question,
	});
}

async function recoverReplyOnlyTelegramJob(
	job: TelegramJob,
	deps: TelegramJobProcessorDeps,
	record: { replyContent?: string; replyContentHash?: string },
): Promise<void> {
	if (!record.replyContent) {
		throw new TelegramManualInterventionError(
			`Telegram update ${job.idempotencyKey ?? fallbackIdempotencyKey(job)} is replying without persisted reply content`,
		);
	}
	try {
		await deps.telegramReplyClient.reply(
			job.chatId,
			record.replyContent,
			job.messageId,
		);
	} catch (error) {
		throw new TelegramManualInterventionError(describeError(error));
	}
	await terminalUpdate(job, deps.telegramUpdateStore, "complete", {
		replyContentHash:
			record.replyContentHash ??
			(await hashCanonicalInput(record.replyContent)),
	});
}

function failureMessage(error: unknown): string {
	let text = unexpectedFailureMessage;
	if (error instanceof ResponsesApiError) {
		text = error.retryable
			? temporaryAiFailureMessage
			: permanentAiFailureMessage;
	}
	return text;
}

function isLegacyPreReplyRetryableError(
	error: unknown,
): error is ResponsesApiError {
	return error instanceof ResponsesApiError && error.retryable;
}

async function beginReply(
	job: TelegramJob,
	store: TelegramUpdateStore,
	text: string,
): Promise<void> {
	const result = await store.beginReply({
		providerSessionId: job.providerSessionId ?? telegramSessionId(job.chatId),
		idempotencyKey: job.idempotencyKey ?? fallbackIdempotencyKey(job),
		replyContentHash: await hashCanonicalInput(text),
		replyContent: text,
	});
	if (result.kind !== "ready") {
		throw new TelegramManualInterventionError(
			`Telegram reply checkpoint was not ready for ${job.idempotencyKey ?? fallbackIdempotencyKey(job)}`,
		);
	}
}

async function terminalUpdate(
	job: TelegramJob,
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
		providerSessionId: job.providerSessionId ?? telegramSessionId(job.chatId),
		idempotencyKey: job.idempotencyKey ?? fallbackIdempotencyKey(job),
		...extra,
	});
}

function selectTelegramRuntime(
	job: TelegramJob,
	deps: TelegramJobProcessorDeps,
): "legacy" | "hermes" {
	return selectTelegramAgentRoute({
		config: deps.config,
		userId: job.userId,
		hasHermesClient: Boolean(deps.hermesClient),
	});
}

function shouldUseHermes(job: TelegramJob, config: AppConfig): boolean {
	return (
		selectTelegramAgentRoute({
			config,
			userId: job.userId,
			hasHermesClient: true,
		}) === "hermes"
	);
}

function fallbackIdempotencyKey(job: TelegramJob): string {
	return job.updateId
		? `telegram:update:${job.updateId}`
		: `telegram:message:${job.chatId}:${job.messageId ?? "unknown"}`;
}

async function hashCanonicalInput(text: string): Promise<string> {
	const bytes = new TextEncoder().encode(text);
	const hash = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(hash)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : "Unknown error";
}
