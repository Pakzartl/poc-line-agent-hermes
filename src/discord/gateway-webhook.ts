import type { CapabilityJobStore } from "../capabilities/job-store";
import type { AppConfig } from "../config";
import type {
	IntentRouterDecision,
	RoutedIntent,
} from "../intent-router/client";
import type { CodeSourceClient } from "../telegram/code-source";
import { isValidGitRef } from "../telegram/source-scope";
import type { TelegramSourceSelectionStore } from "../telegram/source-selection";
import type { TelegramUpdateStore } from "../telegram/update-store";
import { verifyDiscordGatewayRequest } from "./gateway-signature";
import { type DiscordJob, type DiscordJobQueue, discordSessionId } from "./job";
import type { DiscordReplyClient } from "./reply";

export type DiscordGatewayMessage = {
	type: "message_create";
	messageId: string;
	channelId: string;
	guildId?: string;
	userId: string;
	botUserId: string;
	content: string;
	botMentioned: boolean;
};

export type DiscordGatewayWebhookDeps = {
	config: AppConfig;
	discordJobQueue: DiscordJobQueue;
	discordUpdateStore: TelegramUpdateStore;
	discordSourceSelectionStore: TelegramSourceSelectionStore;
	discordCodeSourceClient: CodeSourceClient;
	discordReplyClient: DiscordReplyClient;
	capabilityJobStore?: CapabilityJobStore;
	classifyIntent?: (text: string) => Promise<IntentRouterDecision>;
	discordIntentQueue?: { send(message: DiscordGatewayMessage): Promise<void> };
};

const maxGatewayBodyBytes = 64_000;
const maxMessageLength = 4_000;
const maxChoicesShown = 15;

export async function handleDiscordGatewayMessage(
	request: Request,
	deps: DiscordGatewayWebhookDeps,
): Promise<Response> {
	const contentLength = Number(request.headers.get("content-length") ?? "0");
	if (contentLength > maxGatewayBodyBytes) {
		return new Response("payload too large", { status: 413 });
	}
	let body: string;
	try {
		body = await readGatewayBody(request);
	} catch {
		return new Response("payload too large", { status: 413 });
	}
	if (
		!verifyDiscordGatewayRequest({
			body,
			timestamp: request.headers.get("x-discord-gateway-timestamp"),
			signature: request.headers.get("x-discord-gateway-signature"),
			sharedSecret: deps.config.discord.gatewaySharedSecret,
		})
	) {
		return new Response("invalid gateway signature", { status: 401 });
	}

	let message: DiscordGatewayMessage;
	try {
		message = JSON.parse(body) as DiscordGatewayMessage;
	} catch {
		return new Response("invalid JSON", { status: 400 });
	}
	if (!isGatewayMessage(message)) {
		return new Response("invalid gateway message", { status: 400 });
	}
	if (!deps.config.discord.allowedUserIds.includes(message.userId)) {
		return new Response(null, { status: 204 });
	}
	if (
		message.guildId &&
		!deps.config.discord.allowedGuildIds.includes(message.guildId)
	) {
		return new Response(null, { status: 204 });
	}

	const sessionId = discordSessionId({
		userId: message.userId,
		channelId: message.channelId,
		guildId: message.guildId,
	});
	const text = stripBotMention(message.content, message.botUserId).trim();
	const selection = await deps.discordSourceSelectionStore.getLatest({
		providerSessionId: sessionId,
		userId: message.userId,
	});

	if (selection && isCancel(text)) {
		await deps.discordSourceSelectionStore.clear({
			providerSessionId: sessionId,
		});
		await deps.discordReplyClient.replyToChannel(
			message.channelId,
			"ยกเลิกการเลือก source แล้วครับ",
			message.messageId,
		);
		return accepted();
	}

	// A non-choice mention while the intent picker is open starts a new request.
	// Mentions remain valid answers in repository and branch selection flows.
	const startsFreshIntent =
		message.botMentioned &&
		(!selection ||
			(selection.phase === "intent" && manualIntent(text) === undefined));
	if (startsFreshIntent) {
		if (!text) {
			await deps.discordSourceSelectionStore.clear({
				providerSessionId: sessionId,
			});
			await deps.discordReplyClient.replyToChannel(
				message.channelId,
				"อยากให้ตรวจสอบโค้ดเรื่องอะไรครับ? พิมพ์คำถามพร้อม mention ผมได้เลย",
				message.messageId,
			);
			return accepted();
		}
		if (text.startsWith("/")) return new Response(null, { status: 204 });
		if (selection) {
			await deps.discordSourceSelectionStore.clear({
				providerSessionId: sessionId,
			});
		}
		if (deps.config.intentRouter?.enabled && deps.discordIntentQueue) {
			await deps.discordIntentQueue.send(message);
		} else if (deps.config.intentRouter?.enabled) {
			await routeDiscordMention(message, deps);
		} else {
			await dispatchIntent("code", text, message, deps);
		}
		return accepted();
	}

	if (!selection) {
		return new Response(null, { status: 204 });
	}
	if (!text) {
		return new Response(null, { status: 204 });
	}
	if (selection.phase === "intent") {
		const intent = manualIntent(text);
		if (!intent) {
			await deps.discordReplyClient.replyToChannel(
				message.channelId,
				intentPrompt,
				message.messageId,
			);
			return accepted();
		}
		const consumed = await deps.discordSourceSelectionStore.consume({
			providerSessionId: sessionId,
			userId: message.userId,
			flowId: selection.flowId,
		});
		if (consumed)
			await dispatchIntent(intent, consumed.question, message, deps);
		return accepted();
	}

	if (selection.phase === "repository") {
		const repository = resolveRepository(text, selection.repositories);
		if (!repository) {
			await deps.discordReplyClient.replyToChannel(
				message.channelId,
				choicePrompt(
					"ไม่พบ repository นี้ กรุณาพิมพ์ชื่อ owner/repository จากรายการ",
					selection.repositories,
				),
				message.messageId,
			);
			return accepted();
		}
		const branches =
			await deps.discordCodeSourceClient.listBranches(repository);
		if (branches.length === 0) {
			await deps.discordReplyClient.replyToChannel(
				message.channelId,
				`ไม่พบ branch ใน ${repository} กรุณาเริ่มใหม่โดย mention ผมพร้อมคำถาม`,
				message.messageId,
			);
			await deps.discordSourceSelectionStore.clear({
				providerSessionId: sessionId,
			});
			return accepted();
		}
		await deps.discordSourceSelectionStore.setRepository({
			providerSessionId: sessionId,
			userId: message.userId,
			flowId: selection.flowId,
			repository,
			branches,
		});
		await deps.discordReplyClient.replyToChannel(
			message.channelId,
			choicePrompt(`เลือก branch ของ ${repository}`, branches),
			message.messageId,
		);
		return accepted();
	}

	const repository = selection.repository;
	if (!repository) {
		await deps.discordSourceSelectionStore.clear({
			providerSessionId: sessionId,
		});
		return new Response("invalid source selection state", { status: 409 });
	}
	const branch = text;
	const knownBranch = selection.branches.includes(branch);
	if (
		!isValidGitRef(branch) ||
		(!knownBranch &&
			!(await deps.discordCodeSourceClient.branchExists(repository, branch)))
	) {
		await deps.discordReplyClient.replyToChannel(
			message.channelId,
			choicePrompt(
				`ไม่พบ branch ${branch} กรุณาพิมพ์ชื่อ branch ที่ถูกต้อง`,
				selection.branches,
			),
			message.messageId,
		);
		return accepted();
	}

	const consumed = await deps.discordSourceSelectionStore.consume({
		providerSessionId: sessionId,
		userId: message.userId,
		flowId: selection.flowId,
	});
	if (!consumed) {
		return new Response(null, { status: 204 });
	}
	let deliveryChannelId = message.channelId;
	let sourceMessageId: string | undefined = message.messageId;
	if (deps.discordReplyClient.createThread) {
		try {
			const threadId = await deps.discordReplyClient.createThread(
				message.channelId,
				message.messageId,
				threadName(repository, branch),
			);
			if (threadId) {
				deliveryChannelId = threadId;
				sourceMessageId = undefined;
			}
		} catch (error) {
			console.warn(
				JSON.stringify({
					message:
						"discord investigation thread unavailable; using source channel",
					channelId: message.channelId,
					error: error instanceof Error ? error.message : "unknown error",
				}),
			);
		}
	}
	const jobSessionId = discordSessionId({
		userId: message.userId,
		channelId: deliveryChannelId,
		guildId: message.guildId,
	});
	const job: DiscordJob = {
		interactionId: message.messageId,
		applicationId: deps.config.discord.applicationId,
		userId: message.userId,
		channelId: deliveryChannelId,
		guildId: message.guildId,
		delivery: "channel",
		sourceMessageId,
		action: "chat",
		text: `repo: ${repository}\nbranch: ${branch}\n${consumed.question}`,
		repository,
		branch,
		question: consumed.question,
		capability: {
			kind: "code_investigation",
			repository,
			branch,
			question: consumed.question,
		},
		providerSessionId: jobSessionId,
		idempotencyKey: `discord:message:${message.messageId}`,
	};
	const canonicalInputHash = await hashCanonicalInput(job.text);
	if (deps.capabilityJobStore) {
		await deps.capabilityJobStore.createJob({
			jobId: job.interactionId,
			capability: "code_investigation",
			userId: job.userId,
			guildId: job.guildId,
			channelId: job.channelId,
			actionDigest: canonicalInputHash,
			objective: job.question ?? job.text,
			metadata: {
				delivery: "channel",
				repository,
				branch,
			},
		});
	}
	const claim = await deps.discordUpdateStore.claim({
		providerSessionId: jobSessionId,
		idempotencyKey:
			job.idempotencyKey ?? `discord:message:${message.messageId}`,
		canonicalInputHash,
		updateId: message.messageId,
	});
	if (!claim.claimed) {
		return accepted();
	}
	let queuedJob: DiscordJob = {
		...job,
		canonicalInputHash,
		sessionSequence: claim.record?.sessionSequence,
		generation: claim.record?.generation,
	};
	try {
		const progressMessageId = await deps.discordReplyClient.replyToChannel(
			deliveryChannelId,
			"รอสักครู่ กำลังตรวจสอบโค้ดให้ครับ...",
			sourceMessageId,
		);
		queuedJob = { ...queuedJob, progressMessageId };
		await deps.discordJobQueue.send(queuedJob);
	} catch (error) {
		await deps.discordUpdateStore.release({
			providerSessionId: jobSessionId,
			idempotencyKey: queuedJob.idempotencyKey ?? "",
		});
		if (deps.capabilityJobStore) {
			await deps.capabilityJobStore.transitionJob({
				jobId: job.interactionId,
				from: "queued",
				to: "failed",
				detail: "Discord gateway queue enqueue failed",
			});
		}
		console.error(
			JSON.stringify({
				message: "discord gateway job enqueue failed",
				messageId: message.messageId,
				error: error instanceof Error ? error.message : "Unknown error",
			}),
		);
		await deps.discordReplyClient.replyToChannel(
			deliveryChannelId,
			"ส่งงานไม่สำเร็จ กรุณา mention ผมพร้อมคำถามเพื่อเริ่มใหม่ครับ",
			sourceMessageId,
		);
		return accepted();
	}
	return accepted();
}

function threadName(repository: string, branch: string): string {
	return `Javis · ${repository.split("/").at(-1) ?? repository}@${branch}`.slice(
		0,
		100,
	);
}

const intentPrompt =
	"ยังเลือกประเภทงานให้แน่ใจไม่ได้ครับ พิมพ์ตัวเลือกได้เลย:\n1. code — ตรวจโค้ด / หา bug\n2. news — ค้นข้อมูลจากเว็บพร้อมแหล่งอ้างอิง\n3. general — คุยทั่วไป\nหรือพิมพ์ ยกเลิก";

function manualIntent(text: string): RoutedIntent | undefined {
	const choices: Record<string, RoutedIntent> = {
		"1": "code",
		code: "code",
		"2": "news",
		news: "news",
		"3": "general",
		general: "general",
	};
	return choices[text.trim().toLowerCase()];
}

/** Runs outside webhook latency on the existing Worker queue. Duplicate deliveries
 * are suppressed; uncertain external delivery is not automatically repeated. */
export async function processDiscordIntentMessage(
	message: DiscordGatewayMessage,
	deps: DiscordGatewayWebhookDeps,
): Promise<void> {
	if (
		!isGatewayMessage(message) ||
		!message.botMentioned ||
		!deps.config.discord.allowedUserIds.includes(message.userId) ||
		(message.guildId &&
			!deps.config.discord.allowedGuildIds.includes(message.guildId))
	)
		return;
	const text = stripBotMention(message.content, message.botUserId).trim();
	if (!text || text.startsWith("/")) return;
	const providerSessionId = `${discordSessionId(message)}:intent`;
	const terminal = {
		providerSessionId,
		idempotencyKey: `discord:intent:${message.messageId}`,
	};
	const claim = await deps.discordUpdateStore.claim({
		...terminal,
		canonicalInputHash: await hashCanonicalInput(text),
		updateId: message.messageId,
	});
	if (!claim.claimed) return;
	try {
		// A slash command or previous message may have started a flow meanwhile.
		const active = await deps.discordSourceSelectionStore.getLatest({
			providerSessionId: discordSessionId(message),
			userId: message.userId,
		});
		if (!active) await routeDiscordMention(message, deps);
		await deps.discordUpdateStore.complete(terminal);
	} catch {
		await deps.discordUpdateStore.fail({
			...terminal,
			terminalReason: "intent-routing-failed",
		});
		await deps.discordReplyClient
			.replyToChannel(
				message.channelId,
				"เลือกงานไม่สำเร็จครับ กรุณา mention ใหม่ หรือใช้ /code โดยตรง",
				message.messageId,
			)
			.catch(() => undefined);
	}
}

export async function routeDiscordMention(
	message: DiscordGatewayMessage,
	deps: DiscordGatewayWebhookDeps,
): Promise<void> {
	const question = stripBotMention(message.content, message.botUserId).trim();
	await deps.discordReplyClient
		.sendTyping(message.channelId)
		.catch(() => undefined);
	const typing = setInterval(() => {
		void deps.discordReplyClient
			.sendTyping(message.channelId)
			.catch(() => undefined);
	}, 8000);
	let decision: IntentRouterDecision;
	try {
		decision = (await deps.classifyIntent?.(question)) ?? {
			kind: "clarify",
			reason: "unavailable",
		};
	} catch {
		decision = { kind: "clarify", reason: "unavailable" };
	} finally {
		clearInterval(typing);
	}
	// Never overwrite a source flow that appeared while inference was running.
	const providerSessionId = discordSessionId(message);
	if (
		await deps.discordSourceSelectionStore.getLatest({
			providerSessionId,
			userId: message.userId,
		})
	)
		return;
	console.info(
		JSON.stringify({
			message: "discord intent selected",
			messageId: message.messageId,
			intent: decision.kind === "route" ? decision.intent : "clarify",
			...(decision.kind === "clarify" ? { reason: decision.reason } : {}),
		}),
	);
	if (decision.kind === "route") {
		await dispatchIntent(decision.intent, question, message, deps);
		return;
	}
	await deps.discordSourceSelectionStore.begin({
		providerSessionId,
		userId: message.userId,
		question,
		repositories: [],
		phase: "intent",
	});
	await deps.discordReplyClient.replyToChannel(
		message.channelId,
		intentPrompt,
		message.messageId,
	);
}

async function dispatchIntent(
	intent: RoutedIntent,
	question: string,
	message: DiscordGatewayMessage,
	deps: DiscordGatewayWebhookDeps,
): Promise<void> {
	const providerSessionId =
		intent === "news"
			? `discord:research:${message.messageId}`
			: discordSessionId(message);
	if (intent === "code") {
		const repositories = await deps.discordCodeSourceClient.listRepositories();
		if (!repositories.length) {
			await deps.discordReplyClient.replyToChannel(
				message.channelId,
				"GitHub token นี้ยังมองไม่เห็น repository ที่เลือกได้ครับ",
				message.messageId,
			);
			return;
		}
		await deps.discordSourceSelectionStore.clear({ providerSessionId });
		await deps.discordSourceSelectionStore.begin({
			providerSessionId,
			userId: message.userId,
			question,
			repositories,
		});
		await deps.discordReplyClient.replyToChannel(
			message.channelId,
			choicePrompt("เลือก repository ที่ต้องการตรวจ", repositories),
			message.messageId,
		);
		return;
	}
	const idempotencyKey = `discord:message:${message.messageId}`;
	const canonicalInputHash = await hashCanonicalInput(question);
	const claim = await deps.discordUpdateStore.claim({
		providerSessionId,
		idempotencyKey,
		canonicalInputHash,
		updateId: message.messageId,
	});
	if (!claim.claimed) return;
	try {
		const progressMessageId = await deps.discordReplyClient.replyToChannel(
			message.channelId,
			intent === "news"
				? "รอสักครู่ กำลังค้นเว็บและสรุปข้อมูลพร้อมแหล่งอ้างอิงครับ..."
				: "รอสักครู่ กำลังตอบให้ครับ...",
			message.messageId,
		);
		await deps.discordJobQueue.send({
			interactionId: message.messageId,
			applicationId: deps.config.discord.applicationId,
			userId: message.userId,
			channelId: message.channelId,
			guildId: message.guildId,
			delivery: "channel",
			sourceMessageId: message.messageId,
			action: intent === "news" ? "news" : "chat",
			text: question,
			...(intent === "news" ? { question } : {}),
			providerSessionId,
			idempotencyKey,
			canonicalInputHash,
			sessionSequence: claim.record?.sessionSequence,
			generation: claim.record?.generation,
			progressMessageId,
		});
	} catch {
		await deps.discordUpdateStore.release({
			providerSessionId,
			idempotencyKey,
		});
		await deps.discordReplyClient.replyToChannel(
			message.channelId,
			"ส่งงานไม่สำเร็จครับ กรุณา mention ใหม่",
			message.messageId,
		);
	}
}

export function isGatewayMessage(
	value: unknown,
): value is DiscordGatewayMessage {
	if (!value || typeof value !== "object") {
		return false;
	}
	const item = value as Record<string, unknown>;
	return (
		item.type === "message_create" &&
		isSnowflake(item.messageId) &&
		isSnowflake(item.channelId) &&
		(item.guildId === undefined || isSnowflake(item.guildId)) &&
		isSnowflake(item.userId) &&
		isSnowflake(item.botUserId) &&
		typeof item.content === "string" &&
		item.content.length <= maxMessageLength &&
		typeof item.botMentioned === "boolean"
	);
}

function isSnowflake(value: unknown): value is string {
	return typeof value === "string" && /^[1-9]\d{5,19}$/.test(value);
}

function stripBotMention(content: string, botUserId: string): string {
	return content
		.replaceAll(`<@${botUserId}>`, "")
		.replaceAll(`<@!${botUserId}>`, "");
}

function resolveRepository(
	input: string,
	repositories: readonly string[],
): string | undefined {
	const normalized = input.trim().toLowerCase();
	const exact = repositories.find(
		(repository) => repository.toLowerCase() === normalized,
	);
	if (exact) {
		return exact;
	}
	const matches = repositories.filter(
		(repository) => repository.toLowerCase().split("/").at(-1) === normalized,
	);
	return matches.length === 1 ? matches[0] : undefined;
}

function choicePrompt(title: string, choices: readonly string[]): string {
	const visible = choices.slice(0, maxChoicesShown);
	const lines = visible.map((choice) => `• ${choice}`);
	if (choices.length > visible.length) {
		lines.push(`• …และอีก ${choices.length - visible.length} รายการ`);
	}
	return `${title}:\n${lines.join("\n")}\n\nพิมพ์ชื่อที่ต้องการได้เลย หรือพิมพ์ ยกเลิก`;
}

function isCancel(text: string): boolean {
	return ["cancel", "/cancel", "ยกเลิก"].includes(text.trim().toLowerCase());
}

function accepted(): Response {
	return Response.json({ accepted: true }, { status: 202 });
}

async function readGatewayBody(request: Request): Promise<string> {
	const reader = request.body?.getReader();
	if (!reader) return "";
	const decoder = new TextDecoder();
	let size = 0;
	let text = "";
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxGatewayBodyBytes) throw new Error("payload too large");
			text += decoder.decode(value, { stream: true });
		}
		return text + decoder.decode();
	} finally {
		await reader.cancel().catch(() => undefined);
	}
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
