import type { AppConfig } from "../config";
import type { CodeSourceClient } from "../telegram/code-source";
import { isValidGitRef } from "../telegram/source-scope";
import type { TelegramSourceSelectionStore } from "../telegram/source-selection";
import type { TelegramUpdateStore } from "../telegram/update-store";
import { discordSessionId, type DiscordJob, type DiscordJobQueue } from "./job";
import type { DiscordReplyClient } from "./reply";
import { verifyDiscordGatewayRequest } from "./gateway-signature";

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
	const body = await request.text();
	if (new TextEncoder().encode(body).byteLength > maxGatewayBodyBytes) {
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
	let selection = await deps.discordSourceSelectionStore.getLatest({
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

	if (message.botMentioned) {
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
		const repositories = await deps.discordCodeSourceClient.listRepositories();
		if (repositories.length === 0) {
			await deps.discordReplyClient.replyToChannel(
				message.channelId,
				"GitHub token นี้ยังมองไม่เห็น repository ที่เลือกได้ครับ",
				message.messageId,
			);
			return accepted();
		}
		await deps.discordSourceSelectionStore.clear({
			providerSessionId: sessionId,
		});
		selection = await deps.discordSourceSelectionStore.begin({
			providerSessionId: sessionId,
			userId: message.userId,
			question: text,
			repositories,
		});
		await deps.discordReplyClient.replyToChannel(
			message.channelId,
			choicePrompt("เลือก repository ที่ต้องการตรวจ", repositories),
			message.messageId,
		);
		return accepted();
	}

	if (!selection) {
		return new Response(null, { status: 204 });
	}
	if (!text) {
		return new Response(null, { status: 204 });
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
	const job: DiscordJob = {
		interactionId: message.messageId,
		applicationId: deps.config.discord.applicationId,
		userId: message.userId,
		channelId: message.channelId,
		guildId: message.guildId,
		delivery: "channel",
		sourceMessageId: message.messageId,
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
		providerSessionId: sessionId,
		idempotencyKey: `discord:message:${message.messageId}`,
	};
	const canonicalInputHash = await hashCanonicalInput(job.text);
	const claim = await deps.discordUpdateStore.claim({
		providerSessionId: sessionId,
		idempotencyKey:
			job.idempotencyKey ?? `discord:message:${message.messageId}`,
		canonicalInputHash,
		updateId: message.messageId,
	});
	if (!claim.claimed) {
		return accepted();
	}
	const queuedJob: DiscordJob = {
		...job,
		canonicalInputHash,
		sessionSequence: claim.record?.sessionSequence,
		generation: claim.record?.generation,
	};
	try {
		await deps.discordReplyClient.replyToChannel(
			message.channelId,
			"รอสักครู่ กำลังตรวจสอบโค้ดให้ครับ...",
			message.messageId,
		);
		await deps.discordJobQueue.send(queuedJob);
	} catch (error) {
		await deps.discordUpdateStore.release({
			providerSessionId: sessionId,
			idempotencyKey: queuedJob.idempotencyKey ?? "",
		});
		console.error(
			JSON.stringify({
				message: "discord gateway job enqueue failed",
				messageId: message.messageId,
				error: error instanceof Error ? error.message : "Unknown error",
			}),
		);
		await deps.discordReplyClient.replyToChannel(
			message.channelId,
			"ส่งงานไม่สำเร็จ กรุณา mention ผมพร้อมคำถามเพื่อเริ่มใหม่ครับ",
			message.messageId,
		);
		return accepted();
	}
	return accepted();
}

function isGatewayMessage(value: unknown): value is DiscordGatewayMessage {
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

async function hashCanonicalInput(text: string): Promise<string> {
	const hash = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(text),
	);
	return [...new Uint8Array(hash)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}
