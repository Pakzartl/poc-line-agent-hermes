import { timingSafeEqual } from "node:crypto";
import type { AppConfig } from "../config";
import type { HermesClient } from "../hermes/client";
import type { SessionMemoryStore } from "../memory/types";
import type { TelegramCodeSourceClient } from "./code-source";
import {
	type TelegramJob,
	type TelegramJobQueue,
	telegramSessionId,
} from "./job";
import type {
	TelegramInlineKeyboardMarkup,
	TelegramReplyClient,
} from "./reply";
import { selectTelegramAgentRoute } from "./routing";
import type {
	TelegramSourceSelection,
	TelegramSourceSelectionStore,
} from "./source-selection";
import { isValidGitRef, parseScopedTelegramMessage } from "./source-scope";
import type { TelegramUpdateStore } from "./update-store";

type TelegramMessage = {
	message_id?: number;
	date?: number;
	text?: string;
	from?: { id?: number | string; is_bot?: boolean };
	chat?: { id?: number | string };
};

type TelegramUpdate = {
	update_id?: number | string;
	message?: TelegramMessage;
	callback_query?: {
		id?: string;
		data?: string;
		from?: { id?: number | string; is_bot?: boolean };
		message?: TelegramMessage;
	};
};

export type TelegramWebhookDeps = {
	config: AppConfig;
	memoryStore: SessionMemoryStore;
	telegramJobQueue: TelegramJobQueue;
	telegramReplyClient: TelegramReplyClient;
	telegramUpdateStore: TelegramUpdateStore;
	telegramSourceSelectionStore?: TelegramSourceSelectionStore;
	telegramCodeSourceClient?: TelegramCodeSourceClient;
	hermesClient?: HermesClient;
};

const codeUsageMessage =
	"ใช้ /code ตามด้วยคำถาม เช่น /code learner gateway ตั้ง rate limit ไว้เท่าไหร่";
const codeUnavailableMessage =
	"ยังไม่ได้ตั้งค่า GitHub token สำหรับ /code กรุณาติดต่อผู้ดูแลระบบ";
const staleSelectionMessage =
	"ตัวเลือกนี้หมดอายุหรือถูกแทนที่แล้ว กรุณาเริ่มใหม่ด้วย /code ตามด้วยคำถาม";
const repositoryPageSize = 8;
const branchPageSize = 8;

export async function handleTelegramWebhook(
	request: Request,
	deps: TelegramWebhookDeps,
): Promise<Response> {
	if (
		!secretsMatch(
			request.headers.get("x-telegram-bot-api-secret-token"),
			deps.config.telegram.webhookSecret,
		)
	) {
		return new Response("invalid secret", { status: 401 });
	}

	let update: TelegramUpdate;
	try {
		update = (await request.json()) as TelegramUpdate;
	} catch {
		return new Response("invalid json", { status: 400 });
	}

	if (update.callback_query) {
		return handleCallbackQuery(update, deps);
	}

	const message = update.message;
	if (
		!message?.text ||
		message.chat?.id === undefined ||
		message.from?.id === undefined ||
		message.from?.is_bot
	) {
		return Response.json({ ok: true });
	}

	return handleTextMessage(
		update,
		message as TelegramMessage & {
			text: string;
			chat: { id: number | string };
			from: { id: number | string; is_bot?: boolean };
		},
		deps,
	);
}

async function handleTextMessage(
	update: TelegramUpdate,
	message: TelegramMessage & {
		text: string;
		chat: { id: number | string };
		from: { id: number | string; is_bot?: boolean };
	},
	deps: TelegramWebhookDeps,
): Promise<Response> {
	const chatId = message.chat.id;
	const userId = String(message.from.id);
	const providerSessionId = telegramSessionId(chatId);
	const claimed = await claimUpdate(update, message, message.text, deps);
	if (!claimed.claimed) {
		return Response.json({ ok: true, duplicate: true });
	}

	const replyAndComplete = createReplyAndComplete({
		deps,
		chatId,
		messageId: message.message_id,
		providerSessionId,
		idempotencyKey: claimed.idempotencyKey,
	});

	if (isWhoAmICommand(message.text)) {
		return replyAndComplete(`Your Telegram user ID is: ${userId}`);
	}

	if (!deps.config.telegram.allowedUserIds.includes(userId)) {
		return replyAndComplete(
			`Access denied. Your Telegram user ID is: ${userId}`,
		);
	}

	if (isClearCommand(message.text)) {
		await deps.telegramSourceSelectionStore?.clear({ providerSessionId });
		const route = selectTelegramAgentRoute({
			config: deps.config,
			userId,
			hasHermesClient: Boolean(deps.hermesClient),
		});
		if (route === "hermes") {
			try {
				await deps.hermesClient?.clearSession(providerSessionId);
			} catch {
				return replyAndComplete(
					"Could not clear the Hermes conversation. Please try again later.",
				);
			}
		}
		await deps.memoryStore.clear(providerSessionId);
		return replyAndComplete(
			"Conversation cleared. Your next message will start a new session.",
		);
	}

	const codeQuestion = parseCodeCommand(message.text);
	if (codeQuestion.matched) {
		if (!codeQuestion.question) {
			return replyAndComplete(codeUsageMessage);
		}
		if (
			!deps.telegramSourceSelectionStore ||
			!deps.telegramCodeSourceClient ||
			!deps.config.github.token.trim()
		) {
			return replyAndComplete(codeUnavailableMessage);
		}
		let repositories: readonly string[];
		try {
			repositories = await deps.telegramCodeSourceClient.listRepositories();
		} catch {
			return replyAndComplete(
				"โหลดรายการ repository ไม่สำเร็จ กรุณาลอง /code ใหม่อีกครั้ง",
			);
		}
		if (repositories.length === 0) {
			return replyAndComplete("ไม่พบ repository ที่ GitHub token นี้เข้าถึงได้");
		}
		const selection = await deps.telegramSourceSelectionStore.begin({
			providerSessionId,
			userId,
			question: codeQuestion.question,
			repositories,
			messageId: message.message_id,
		});
		return replyAndComplete("เลือก repository ที่ต้องการตรวจ", {
			replyMarkup: repositoryKeyboard(selection, 0),
		});
	}

	const customSelection = await deps.telegramSourceSelectionStore?.get({
		providerSessionId,
		userId,
	});
	if (customSelection?.phase === "custom_branch") {
		return handleCustomBranch({
			selection: customSelection,
			branch: message.text.trim(),
			update,
			message,
			claim: claimed,
			deps,
			replyAndComplete,
		});
	}

	const scopedMessage = parseScopedTelegramMessage(message.text);
	const job: TelegramJob = scopedMessage.ok
		? {
				...jobMetadata(update, message, claimed),
				chatId,
				messageId: message.message_id,
				userId,
				text: message.text,
				repository: scopedMessage.value.repository,
				branch: scopedMessage.value.branch,
				question: scopedMessage.value.question,
			}
		: {
				...jobMetadata(update, message, claimed),
				chatId,
				messageId: message.message_id,
				userId,
				text: message.text,
				repository: "",
				branch: "",
				question: message.text,
			};
	return enqueueJob(job, deps);
}

async function handleCallbackQuery(
	update: TelegramUpdate,
	deps: TelegramWebhookDeps,
): Promise<Response> {
	const callback = update.callback_query;
	const message = callback?.message;
	if (
		!callback?.id ||
		!callback.data ||
		callback.from?.id === undefined ||
		callback.from.is_bot ||
		message?.chat?.id === undefined
	) {
		return Response.json({ ok: true });
	}

	const userId = String(callback.from.id);
	const action = parseCallbackData(callback.data);
	await answerCallback(
		deps.telegramReplyClient,
		callback.id,
		callbackProgressText(action),
	);
	if (!deps.config.telegram.allowedUserIds.includes(userId)) {
		return Response.json({ ok: true, denied: true });
	}

	const chatId = message.chat.id;
	const providerSessionId = telegramSessionId(chatId);
	const claimed = await claimUpdate(update, message, callback.data, deps);
	if (!claimed.claimed) {
		return Response.json({ ok: true, duplicate: true });
	}
	const replyAndComplete = createReplyAndComplete({
		deps,
		chatId,
		providerSessionId,
		idempotencyKey: claimed.idempotencyKey,
	});
	if (!action || !deps.telegramSourceSelectionStore) {
		return replyAndComplete(staleSelectionMessage);
	}

	if (action.kind === "cancel") {
		const consumed = await deps.telegramSourceSelectionStore.consume({
			providerSessionId,
			userId,
			flowId: action.flowId,
		});
		return replyAndComplete(
			consumed ? "ยกเลิกการเลือก source แล้ว" : staleSelectionMessage,
		);
	}

	if (action.kind === "repositoryPage") {
		const selection = await deps.telegramSourceSelectionStore.get({
			providerSessionId,
			userId,
			flowId: action.flowId,
		});
		return selection?.phase === "repository"
			? replyAndComplete("เลือก repository ที่ต้องการตรวจ", {
					replyMarkup: repositoryKeyboard(selection, action.index),
				})
			: replyAndComplete(staleSelectionMessage);
	}

	if (action.kind === "repository") {
		const pending = await deps.telegramSourceSelectionStore.get({
			providerSessionId,
			userId,
			flowId: action.flowId,
		});
		const repository = pending?.repositories[action.index];
		if (!repository || !deps.telegramCodeSourceClient) {
			return replyAndComplete(staleSelectionMessage);
		}
		if (pending?.phase === "branch" && pending.repository === repository) {
			return replyAndComplete(`เลือก branch ของ ${repository}`, {
				replyMarkup: branchKeyboard(pending, 0),
			});
		}
		if (!pending || pending.phase !== "repository") {
			return replyAndComplete(staleSelectionMessage);
		}
		try {
			const branches =
				await deps.telegramCodeSourceClient.listBranches(repository);
			if (branches.length === 0) {
				return replyAndComplete("ไม่พบ branch ใน repository นี้");
			}
			const selection = await deps.telegramSourceSelectionStore.setRepository({
				providerSessionId,
				userId,
				flowId: action.flowId,
				repository,
				branches,
			});
			if (selection) {
				return replyAndComplete(`เลือก branch ของ ${repository}`, {
					replyMarkup: branchKeyboard(selection, 0),
				});
			}
			const concurrentlySelected = await deps.telegramSourceSelectionStore.get({
				providerSessionId,
				userId,
				flowId: action.flowId,
			});
			if (
				concurrentlySelected?.phase === "branch" &&
				concurrentlySelected.repository === repository
			) {
				return replyAndComplete(`เลือก branch ของ ${repository}`, {
					replyMarkup: branchKeyboard(concurrentlySelected, 0),
				});
			}
			return replyAndComplete(staleSelectionMessage);
		} catch {
			return replyAndComplete(
				"โหลดรายชื่อ branch ไม่สำเร็จ กรุณาลอง /code ใหม่อีกครั้ง",
			);
		}
	}

	const selection = await deps.telegramSourceSelectionStore.get({
		providerSessionId,
		userId,
		flowId: action.flowId,
	});
	if (!selection || selection.phase !== "branch" || !selection.repository) {
		return replyAndComplete(staleSelectionMessage);
	}

	if (action.kind === "page") {
		return replyAndComplete(`เลือก branch ของ ${selection.repository}`, {
			replyMarkup: branchKeyboard(selection, action.index),
		});
	}

	if (action.kind === "custom") {
		const waiting = await deps.telegramSourceSelectionStore.waitForCustomBranch(
			{
				providerSessionId,
				userId,
				flowId: action.flowId,
			},
		);
		return replyAndComplete(
			waiting ? "พิมพ์ชื่อ branch ที่ต้องการตรวจในข้อความถัดไป" : staleSelectionMessage,
		);
	}

	if (action.kind !== "branch") {
		return replyAndComplete(staleSelectionMessage);
	}
	const branch = selection.branches[action.index];
	if (!branch) {
		return replyAndComplete(staleSelectionMessage);
	}
	const consumed = await deps.telegramSourceSelectionStore.consume({
		providerSessionId,
		userId,
		flowId: action.flowId,
	});
	if (!consumed?.repository) {
		return replyAndComplete(staleSelectionMessage);
	}
	return enqueueJob(
		selectionJob({
			selection: consumed,
			branch,
			update,
			message,
			claim: claimed,
			chatId,
			userId,
		}),
		deps,
	);
}

async function handleCustomBranch(input: {
	selection: TelegramSourceSelection;
	branch: string;
	update: TelegramUpdate;
	message: TelegramMessage & {
		text: string;
		chat: { id: number | string };
		from: { id: number | string; is_bot?: boolean };
	};
	claim: Awaited<ReturnType<typeof claimUpdate>>;
	deps: TelegramWebhookDeps;
	replyAndComplete: ReturnType<typeof createReplyAndComplete>;
}): Promise<Response> {
	if (
		!input.selection.repository ||
		!isValidGitRef(input.branch) ||
		!input.deps.telegramCodeSourceClient ||
		!input.deps.telegramSourceSelectionStore
	) {
		return input.replyAndComplete("ชื่อ branch ไม่ถูกต้อง กรุณาพิมพ์ชื่อ branch ใหม่");
	}
	try {
		if (
			!(await input.deps.telegramCodeSourceClient.branchExists(
				input.selection.repository,
				input.branch,
			))
		) {
			return input.replyAndComplete("ไม่พบ branch นี้ กรุณาตรวจชื่อแล้วพิมพ์ใหม่");
		}
	} catch {
		return input.replyAndComplete("ตรวจสอบ branch ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
	}
	const consumed = await input.deps.telegramSourceSelectionStore.consume({
		providerSessionId: telegramSessionId(input.message.chat.id),
		userId: String(input.message.from.id),
		flowId: input.selection.flowId,
	});
	if (!consumed?.repository) {
		return input.replyAndComplete(staleSelectionMessage);
	}
	return enqueueJob(
		selectionJob({
			selection: consumed,
			branch: input.branch,
			update: input.update,
			message: input.message,
			claim: input.claim,
			chatId: input.message.chat.id,
			userId: String(input.message.from.id),
		}),
		input.deps,
	);
}

function selectionJob(input: {
	selection: TelegramSourceSelection;
	branch: string;
	update: TelegramUpdate;
	message: TelegramMessage;
	claim: Awaited<ReturnType<typeof claimUpdate>>;
	chatId: number | string;
	userId: string;
}): TelegramJob {
	const repository = input.selection.repository;
	if (!repository) {
		throw new Error("Selected repository is missing");
	}
	return {
		...jobMetadata(input.update, input.message, input.claim),
		chatId: input.chatId,
		messageId: input.selection.messageId,
		userId: input.userId,
		text: `repo: ${repository}\nbranch: ${input.branch}\n${input.selection.question}`,
		repository,
		branch: input.branch,
		question: input.selection.question,
	};
}

async function enqueueJob(
	job: TelegramJob,
	deps: TelegramWebhookDeps,
): Promise<Response> {
	try {
		await deps.telegramJobQueue.send(job);
		return Response.json({ ok: true, accepted: true });
	} catch (error) {
		try {
			await deps.telegramUpdateStore.release({
				providerSessionId:
					job.providerSessionId ?? telegramSessionId(job.chatId),
				idempotencyKey:
					job.idempotencyKey ??
					`telegram:message:${job.chatId}:${job.messageId ?? "unknown"}`,
			});
		} catch (releaseError) {
			console.error(
				JSON.stringify({
					message: "telegram update release failed",
					updateId: job.updateId ?? job.idempotencyKey,
					error:
						releaseError instanceof Error
							? releaseError.message
							: "Unknown error",
				}),
			);
		}
		throw error;
	}
}

async function claimUpdate(
	update: TelegramUpdate,
	message: TelegramMessage,
	canonicalInput: string,
	deps: TelegramWebhookDeps,
): Promise<{
	claimed: boolean;
	idempotencyKey: string;
	canonicalInputHash: string;
	record?: { sessionSequence?: number; generation?: string };
}> {
	const chatId = message.chat?.id;
	if (chatId === undefined) {
		return {
			claimed: false,
			idempotencyKey: "telegram:invalid",
			canonicalInputHash: "",
		};
	}
	const providerSessionId = telegramSessionId(chatId);
	const updateId = getUpdateId(update, message);
	const idempotencyKey = getIdempotencyKey(update, message);
	const canonicalInputHash = await hashCanonicalInput(canonicalInput);
	const claim = await deps.telegramUpdateStore.claim({
		providerSessionId,
		idempotencyKey,
		canonicalInputHash,
		...(updateId ? { updateId } : {}),
		...(message.message_id !== undefined
			? { messageId: String(message.message_id) }
			: {}),
		...(message.date ? { providerTimestamp: String(message.date) } : {}),
	});
	return {
		claimed: claim.claimed,
		idempotencyKey,
		canonicalInputHash,
		record: claim.record,
	};
}

function jobMetadata(
	update: TelegramUpdate,
	message: TelegramMessage,
	claim: Awaited<ReturnType<typeof claimUpdate>>,
): Pick<
	TelegramJob,
	| "updateId"
	| "idempotencyKey"
	| "providerSessionId"
	| "sessionSequence"
	| "generation"
	| "canonicalInputHash"
> {
	const chatId = message.chat?.id;
	if (chatId === undefined) {
		throw new Error("Telegram chat ID is required");
	}
	return {
		updateId: getUpdateId(update, message),
		idempotencyKey: claim.idempotencyKey,
		providerSessionId: telegramSessionId(chatId),
		sessionSequence: claim.record?.sessionSequence,
		generation: claim.record?.generation,
		canonicalInputHash: claim.canonicalInputHash,
	};
}

function createReplyAndComplete(input: {
	deps: TelegramWebhookDeps;
	chatId: number | string;
	messageId?: number;
	providerSessionId: string;
	idempotencyKey: string;
}) {
	return async (
		text: string,
		options?: { replyMarkup?: TelegramInlineKeyboardMarkup },
	): Promise<Response> => {
		const replyContentHash = await hashCanonicalInput(text);
		const checkpoint = await input.deps.telegramUpdateStore.beginReply({
			providerSessionId: input.providerSessionId,
			idempotencyKey: input.idempotencyKey,
			replyContentHash,
			replyContent: text,
		});
		if (checkpoint.kind !== "ready") {
			return Response.json({ ok: true, duplicate: true });
		}
		try {
			await input.deps.telegramReplyClient.reply(
				input.chatId,
				text,
				input.messageId,
				options,
			);
		} catch (error) {
			await input.deps.telegramUpdateStore.markUncertain({
				providerSessionId: input.providerSessionId,
				idempotencyKey: input.idempotencyKey,
			});
			throw error;
		}
		await input.deps.telegramUpdateStore.complete({
			providerSessionId: input.providerSessionId,
			idempotencyKey: input.idempotencyKey,
			replyContentHash,
		});
		return Response.json({ ok: true });
	};
}

function repositoryKeyboard(
	selection: TelegramSourceSelection,
	requestedPage: number,
): TelegramInlineKeyboardMarkup {
	const pageCount = Math.max(
		1,
		Math.ceil(selection.repositories.length / repositoryPageSize),
	);
	const page = Math.min(Math.max(0, requestedPage), pageCount - 1);
	const start = page * repositoryPageSize;
	const repositoryRows = selection.repositories
		.slice(start, start + repositoryPageSize)
		.map((repository, offset) => [
			{
				text: repository,
				callback_data: `cs:r:${selection.flowId}:${start + offset}`,
			},
		]);
	const navigation: { text: string; callback_data: string }[] = [];
	if (page > 0) {
		navigation.push({
			text: "← ก่อนหน้า",
			callback_data: `cs:q:${selection.flowId}:${page - 1}`,
		});
	}
	if (page + 1 < pageCount) {
		navigation.push({
			text: "ถัดไป →",
			callback_data: `cs:q:${selection.flowId}:${page + 1}`,
		});
	}
	return {
		inline_keyboard: [
			...repositoryRows,
			...(navigation.length > 0 ? [navigation] : []),
			[
				{
					text: "ยกเลิก",
					callback_data: `cs:x:${selection.flowId}`,
				},
			],
		],
	};
}

function branchKeyboard(
	selection: TelegramSourceSelection,
	requestedPage: number,
): TelegramInlineKeyboardMarkup {
	const pageCount = Math.max(
		1,
		Math.ceil(selection.branches.length / branchPageSize),
	);
	const page = Math.min(Math.max(0, requestedPage), pageCount - 1);
	const start = page * branchPageSize;
	const branchRows = selection.branches
		.slice(start, start + branchPageSize)
		.map((branch, offset) => [
			{
				text: branch,
				callback_data: `cs:b:${selection.flowId}:${start + offset}`,
			},
		]);
	const navigation: { text: string; callback_data: string }[] = [];
	if (page > 0) {
		navigation.push({
			text: "← ก่อนหน้า",
			callback_data: `cs:p:${selection.flowId}:${page - 1}`,
		});
	}
	if (page + 1 < pageCount) {
		navigation.push({
			text: "ถัดไป →",
			callback_data: `cs:p:${selection.flowId}:${page + 1}`,
		});
	}
	return {
		inline_keyboard: [
			...branchRows,
			...(navigation.length > 0 ? [navigation] : []),
			[
				{
					text: "พิมพ์ branch เอง",
					callback_data: `cs:c:${selection.flowId}`,
				},
				{ text: "ยกเลิก", callback_data: `cs:x:${selection.flowId}` },
			],
		],
	};
}

function parseCallbackData(data: string):
	| {
			kind: "repository" | "repositoryPage" | "branch" | "page";
			flowId: string;
			index: number;
	  }
	| { kind: "custom" | "cancel"; flowId: string }
	| undefined {
	const match = /^cs:([rbpqcx]):([0-9a-f-]{36})(?::(\d+))?$/.exec(data);
	if (!match) {
		return undefined;
	}
	const code = match[1];
	const flowId = match[2];
	if (!code || !flowId) {
		return undefined;
	}
	if (code === "c" || code === "x") {
		return { kind: code === "c" ? "custom" : "cancel", flowId };
	}
	const index = Number(match[3]);
	if (!Number.isSafeInteger(index) || index < 0) {
		return undefined;
	}
	return {
		kind:
			code === "r"
				? "repository"
				: code === "q"
					? "repositoryPage"
					: code === "b"
						? "branch"
						: "page",
		flowId,
		index,
	};
}

function callbackProgressText(
	action: ReturnType<typeof parseCallbackData>,
): string | undefined {
	if (action?.kind === "repository") {
		return "กำลังโหลด branch…";
	}
	if (action?.kind === "branch") {
		return "กำลังส่งคำถาม…";
	}
	return undefined;
}

function parseCodeCommand(text: string): {
	matched: boolean;
	question?: string;
} {
	const match = /^\/code(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text.trim());
	if (!match) {
		return { matched: false };
	}
	const question = match[1]?.trim();
	return question ? { matched: true, question } : { matched: true };
}

async function answerCallback(
	client: TelegramReplyClient,
	callbackQueryId: string,
	text?: string,
): Promise<void> {
	try {
		await client.answerCallbackQuery?.(callbackQueryId, text);
	} catch (error) {
		console.error(
			JSON.stringify({
				message: "telegram callback answer failed",
				error: error instanceof Error ? error.message : "Unknown error",
			}),
		);
	}
}

function getUpdateId(
	update: TelegramUpdate,
	message: TelegramMessage,
): string | undefined {
	if (update.update_id !== undefined) {
		return String(update.update_id);
	}
	if (message.message_id !== undefined && message.chat?.id !== undefined) {
		return `message:${message.chat.id}:${message.message_id}`;
	}
	return undefined;
}

function getIdempotencyKey(
	update: TelegramUpdate,
	message: TelegramMessage,
): string {
	if (update.update_id !== undefined) {
		return `telegram:update:${String(update.update_id)}`;
	}
	if (message.message_id !== undefined && message.chat?.id !== undefined) {
		return `telegram:message:${message.chat.id}:${message.message_id}`;
	}
	return `telegram:generated:${crypto.randomUUID()}`;
}

async function hashCanonicalInput(text: string): Promise<string> {
	const bytes = new TextEncoder().encode(text);
	const hash = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(hash)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

function isWhoAmICommand(text: string): boolean {
	return /^\/whoami(?:@\w+)?(?:\s|$)/i.test(text.trim());
}

function isClearCommand(text: string): boolean {
	return /^\/clear(?:@\w+)?(?:\s|$)/i.test(text.trim());
}

function secretsMatch(received: string | null, expected: string): boolean {
	if (!received || !expected) {
		return false;
	}
	const receivedBytes = Buffer.from(received);
	const expectedBytes = Buffer.from(expected);
	return (
		receivedBytes.length === expectedBytes.length &&
		timingSafeEqual(receivedBytes, expectedBytes)
	);
}
