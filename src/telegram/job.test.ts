import { describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ResponsesApiError } from "../agent/llm-client";
import { HermesApiError } from "../hermes/client";
import type { ConversationMessage } from "../memory/types";
import { createDurableObjectTelegramUpdateStore } from "./update-store";
import { formatHermesSourceInput } from "./source-scope";
import {
	processTelegramQueueMessage,
	telegramSessionId,
	type TelegramJob,
	type TelegramJobProcessorDeps,
} from "./job";

mock.module("cloudflare:workers", () => ({
	DurableObject: class DurableObject {
		protected ctx: DurableObjectState;
		protected env: Record<string, unknown>;

		constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
			this.ctx = ctx;
			this.env = env;
		}
	},
}));

describe("Telegram queued jobs", () => {
	test("uses a versioned Hermes session after the source-selection guardrail change", () => {
		expect(telegramSessionId(9001)).toBe("telegram:chat:source-v4:9001");
	});

	test("sends general chat to Hermes without a repository scope envelope", async () => {
		const inputs: string[] = [];
		const chatActions: (number | string)[] = [];
		const deps = processorDeps({
			config: loadHermesTelegramConfig(),
			hermesClient: {
				chat: async (input) => {
					inputs.push(input.input);
					return { text: "เข้าใจครับ" };
				},
				listMessages: async () => [],
				lastMessageMarker: async () => undefined,
				clearSession: async () => undefined,
			},
			telegramReplyClient: {
				reply: async () => undefined,
				sendChatAction: async (chatId) => {
					chatActions.push(chatId);
				},
			},
		});
		let acked = false;

		await processTelegramQueueMessage(
			{
				body: {
					...telegramJob(),
					text: "อ่อ",
					question: "อ่อ",
					repository: "",
					branch: "",
				},
				attempts: 1,
				ack: () => {
					acked = true;
				},
				retry: () => undefined,
			},
			deps,
		);

		expect(inputs).toEqual(["อ่อ"]);
		expect(chatActions).toEqual([9001]);
		expect(acked).toBe(true);
	});

	test("runs the agent outside the webhook and completes the update after replying", async () => {
		const history: ConversationMessage[] = [
			{ role: "user", content: "find login" },
			{ role: "assistant", content: "found it" },
		];
		const seenHistory: ConversationMessage[][] = [];
		const appended: ConversationMessage[][] = [];
		const replies: unknown[][] = [];
		const completed: string[] = [];
		let acked = false;
		const deps = processorDeps({
			orchestrator: {
				answer: async (_question, previous = []) => {
					seenHistory.push(previous);
					return "commit abc123";
				},
			},
			memoryStore: {
				read: async () => history,
				append: async (_sessionId, messages) => {
					appended.push(messages);
					return [...history, ...messages];
				},
				clear: async () => undefined,
			},
			telegramReplyClient: {
				reply: async (...args) => {
					replies.push(args);
				},
			},
			telegramUpdateStore: {
				claim: async () => ({ claimed: true, duplicate: false }),
				dispatchLease: async () => ({ kind: "leased", record: record() }),
				complete: async (updateId) => {
					completed.push(updateId.idempotencyKey);
				},
				fail: async () => undefined,
				markUncertain: async () => undefined,
				release: async () => undefined,
				retryPreReply: async () => undefined,
				beginReply: async () => ({ kind: "ready", record: record() }),
			},
		});

		await processTelegramQueueMessage(
			{
				body: telegramJob(),
				attempts: 1,
				ack: () => {
					acked = true;
				},
				retry: () => undefined,
			},
			deps,
		);

		expect(seenHistory).toEqual([history]);
		expect(appended).toEqual([
			[
				{ role: "user", content: "list every custom rate limit" },
				{ role: "assistant", content: "commit abc123" },
			],
		]);
		expect(replies).toEqual([[9001, "commit abc123", 42]]);
		expect(completed).toEqual(["telegram:update:790"]);
		expect(acked).toBe(true);
	});

	test("retries a transient OpenAI failure without acknowledging the job", async () => {
		const retries: { delaySeconds?: number }[] = [];
		let acked = false;
		let replyCalls = 0;
		const deps = processorDeps({
			orchestrator: {
				answer: async () => {
					throw responsesError(true);
				},
			},
			telegramReplyClient: {
				reply: async () => {
					replyCalls += 1;
				},
			},
		});

		await processTelegramQueueMessage(
			{
				body: telegramJob(),
				attempts: 1,
				ack: () => {
					acked = true;
				},
				retry: (options) => retries.push(options ?? {}),
			},
			deps,
		);

		expect(retries).toEqual([{ delaySeconds: 30 }]);
		expect(replyCalls).toBe(0);
		expect(acked).toBe(false);
	});

	test("does not persist an answer that Telegram failed to deliver", async () => {
		let appendCalls = 0;
		const retries: { delaySeconds?: number }[] = [];
		const deps = processorDeps({
			memoryStore: {
				read: async () => [],
				append: async (_sessionId, messages) => {
					appendCalls += 1;
					return messages;
				},
				clear: async () => undefined,
			},
			telegramReplyClient: {
				reply: async () => {
					throw new Error("Telegram reply failed with status 429");
				},
			},
		});

		await processTelegramQueueMessage(
			{
				body: telegramJob(),
				attempts: 1,
				ack: () => undefined,
				retry: (options) => retries.push(options ?? {}),
			},
			deps,
		);

		expect(appendCalls).toBe(0);
		expect(retries).toEqual([{ delaySeconds: 30 }]);
	});

	test("notifies the user after transient failures exhaust queue retries", async () => {
		const replies: unknown[][] = [];
		const failed: string[] = [];
		let acked = false;
		const deps = processorDeps({
			orchestrator: {
				answer: async () => {
					throw responsesError(true);
				},
			},
			telegramReplyClient: {
				reply: async (...args) => {
					replies.push(args);
				},
			},
			telegramUpdateStore: {
				claim: async () => ({ claimed: true, duplicate: false }),
				dispatchLease: async () => ({ kind: "leased", record: record() }),
				complete: async () => undefined,
				fail: async (updateId) => {
					failed.push(updateId.idempotencyKey);
				},
				markUncertain: async () => undefined,
				release: async () => undefined,
				retryPreReply: async () => undefined,
				beginReply: async () => ({ kind: "ready", record: record() }),
			},
		});

		await processTelegramQueueMessage(
			{
				body: telegramJob(),
				attempts: 3,
				ack: () => {
					acked = true;
				},
				retry: () => undefined,
			},
			deps,
		);

		expect(replies).toHaveLength(1);
		expect(replies[0]?.[1]).toContain("ระบบ AI มีคำขอหนาแน่น");
		expect(failed).toEqual(["telegram:update:790"]);
		expect(acked).toBe(true);
	});

	test("does not retry permanent OpenAI quota failures", async () => {
		const replies: unknown[][] = [];
		let retryCalls = 0;
		let acked = false;
		const deps = processorDeps({
			orchestrator: {
				answer: async () => {
					throw responsesError(false);
				},
			},
			telegramReplyClient: {
				reply: async (...args) => {
					replies.push(args);
				},
			},
		});

		await processTelegramQueueMessage(
			{
				body: telegramJob(),
				attempts: 1,
				ack: () => {
					acked = true;
				},
				retry: () => {
					retryCalls += 1;
				},
			},
			deps,
		);

		expect(retryCalls).toBe(0);
		expect(replies[0]?.[1]).toContain("ระบบ AI ไม่พร้อมใช้งาน");
		expect(acked).toBe(true);
	});

	test("does not fall back to legacy after a Hermes dispatch failure", async () => {
		let legacyCalls = 0;
		let retryCalls = 0;
		let replyCalls = 0;
		const deps = processorDeps({
			config: loadHermesTelegramConfig(),
			orchestrator: {
				answer: async () => {
					legacyCalls += 1;
					return "legacy answer";
				},
			},
			hermesClient: {
				lastMessageMarker: async () => undefined,
				listMessages: async () => [],
				clearSession: async () => undefined,
				chat: async () => {
					throw new HermesApiError({
						message: "Hermes request failed with status 503",
						status: 503,
						retryable: true,
						ambiguous: true,
					});
				},
			},
			telegramReplyClient: {
				reply: async () => {
					replyCalls += 1;
				},
			},
		});

		await processTelegramQueueMessage(
			{
				body: telegramJob(),
				attempts: 1,
				ack: () => undefined,
				retry: () => {
					retryCalls += 1;
				},
			},
			deps,
		);

		expect(legacyCalls).toBe(0);
		expect(replyCalls).toBe(0);
		expect(retryCalls).toBe(1);
	});

	test("terminally notifies a proven Hermes rejection without legacy fallback", async () => {
		let legacyCalls = 0;
		const replies: unknown[][] = [];
		const failed: string[] = [];
		let acked = false;
		const deps = processorDeps({
			config: loadHermesTelegramConfig(),
			orchestrator: {
				answer: async () => {
					legacyCalls += 1;
					return "legacy answer";
				},
			},
			hermesClient: {
				lastMessageMarker: async () => undefined,
				listMessages: async () => [],
				clearSession: async () => undefined,
				chat: async () => {
					throw new HermesApiError({
						message: "Hermes request failed with status 422",
						status: 422,
						retryable: false,
					});
				},
			},
			telegramReplyClient: {
				reply: async (...args) => {
					replies.push(args);
				},
			},
			telegramUpdateStore: {
				claim: async () => ({ claimed: true, duplicate: false }),
				dispatchLease: async () => ({ kind: "leased", record: record() }),
				complete: async () => undefined,
				fail: async (input) => {
					failed.push(input.idempotencyKey);
				},
				markUncertain: async () => undefined,
				release: async () => undefined,
				retryPreReply: async () => undefined,
				beginReply: async () => ({ kind: "ready", record: record() }),
			},
		});

		await processTelegramQueueMessage(
			{
				body: telegramJob(),
				attempts: 1,
				ack: () => {
					acked = true;
				},
				retry: () => undefined,
			},
			deps,
		);

		expect(legacyCalls).toBe(0);
		expect(replies).toHaveLength(1);
		expect(failed).toEqual(["telegram:update:790"]);
		expect(acked).toBe(true);
	});

	test("recovers a Hermes answer once and retries only the persisted Telegram reply", async () => {
		const store = await createDurableStoreForJob();
		const job = await claimedTelegramJob(store, {
			updateId: "recover-1",
			text: "recover me",
		});
		let chatCalls = 0;
		let listCalls = 0;
		const replies: string[] = [];
		const deps = processorDeps({
			config: loadHermesTelegramConfig(),
			telegramUpdateStore: store,
			hermesClient: {
				lastMessageMarker: async () => undefined,
				clearSession: async () => undefined,
				chat: async () => {
					chatCalls += 1;
					throw new HermesApiError({
						message: "Hermes request timed out after dispatch",
						retryable: true,
						ambiguous: true,
					});
				},
				listMessages: async () => {
					listCalls += 1;
					return [
						{
							id: "u1",
							role: "user",
							content: formatHermesSourceInput({
								repository: job.repository,
								branch: job.branch,
								question: job.question,
							}),
						},
						{ id: "a1", role: "assistant", content: "recovered answer" },
					];
				},
			},
			telegramReplyClient: {
				reply: async (_chatId, text) => {
					replies.push(text);
					if (replies.length === 1) {
						throw new Error("Telegram send failed");
					}
				},
			},
		});
		const attempts = await runQueueAttempts(job, deps, [1, 2, 3]);

		expect(attempts).toEqual([
			{ acked: false, retries: 1 },
			{ acked: false, retries: 1 },
			{ acked: true, retries: 0 },
		]);
		expect(chatCalls).toBe(1);
		expect(listCalls).toBe(1);
		expect(replies).toEqual(["recovered answer", "recovered answer"]);
	});

	test("keeps polling an ambiguous Hermes dispatch before terminal failure", async () => {
		const store = await createDurableStoreForJob();
		const job = await claimedTelegramJob(store, {
			updateId: "recover-pending-1",
			text: "wait for the dispatched answer",
		});
		let chatCalls = 0;
		let listCalls = 0;
		const replies: string[] = [];
		const deps = processorDeps({
			config: loadHermesTelegramConfig(),
			telegramUpdateStore: store,
			hermesClient: {
				lastMessageMarker: async () => undefined,
				clearSession: async () => undefined,
				chat: async () => {
					chatCalls += 1;
					throw new HermesApiError({
						message: "Hermes request timed out after dispatch",
						retryable: true,
						ambiguous: true,
					});
				},
				listMessages: async () => {
					listCalls += 1;
					return [];
				},
			},
			telegramReplyClient: {
				reply: async (_chatId, text) => {
					replies.push(text);
				},
			},
		});

		const attempts = await runQueueAttempts(job, deps, [1, 2, 3]);

		expect(attempts).toEqual([
			{ acked: false, retries: 1 },
			{ acked: false, retries: 1 },
			{ acked: true, retries: 0 },
		]);
		expect(chatCalls).toBe(1);
		expect(listCalls).toBe(2);
		expect(replies).toHaveLength(1);
		expect(replies[0]).toContain("เกิดข้อผิดพลาดระหว่างประมวลผล");
	});

	test("retries a fresh persisted answer without a second Hermes chat", async () => {
		const store = await createDurableStoreForJob();
		const job = await claimedTelegramJob(store, {
			updateId: "fresh-1",
			text: "fresh answer please",
		});
		let chatCalls = 0;
		const replies: string[] = [];
		const deps = processorDeps({
			config: loadHermesTelegramConfig(),
			telegramUpdateStore: store,
			hermesClient: {
				lastMessageMarker: async () => undefined,
				clearSession: async () => undefined,
				listMessages: async () => [],
				chat: async () => {
					chatCalls += 1;
					return { text: "fresh answer" };
				},
			},
			telegramReplyClient: {
				reply: async (_chatId, text) => {
					replies.push(text);
					if (replies.length === 1) {
						throw new Error("Telegram send failed");
					}
				},
			},
		});
		const attempts = await runQueueAttempts(job, deps, [1, 2]);

		expect(attempts).toEqual([
			{ acked: false, retries: 1 },
			{ acked: true, retries: 0 },
		]);
		expect(chatCalls).toBe(1);
		expect(replies).toEqual(["fresh answer", "fresh answer"]);
	});

	test("releases the session after Telegram delivery exhausts retries", async () => {
		const store = await createDurableStoreForJob();
		const firstJob = await claimedTelegramJob(store, {
			updateId: "reply-terminal-1",
			text: "first answer",
		});
		let chatCalls = 0;
		let replyCalls = 0;
		const delivered: string[] = [];
		const deps = processorDeps({
			config: loadHermesTelegramConfig(),
			telegramUpdateStore: store,
			hermesClient: {
				lastMessageMarker: async () => undefined,
				clearSession: async () => undefined,
				listMessages: async () => [],
				chat: async () => {
					chatCalls += 1;
					return { text: chatCalls === 1 ? "first result" : "next result" };
				},
			},
			telegramReplyClient: {
				reply: async (_chatId, text) => {
					replyCalls += 1;
					if (replyCalls <= 3) {
						throw new Error("Telegram delivery remained uncertain");
					}
					delivered.push(text);
				},
			},
		});

		expect(await runQueueAttempts(firstJob, deps, [1, 2, 3])).toEqual([
			{ acked: false, retries: 1 },
			{ acked: false, retries: 1 },
			{ acked: true, retries: 0 },
		]);

		const nextJob = await claimedTelegramJob(store, {
			updateId: "reply-terminal-2",
			text: "next answer",
		});
		expect(await runQueueAttempts(nextJob, deps, [1])).toEqual([
			{ acked: true, retries: 0 },
		]);
		expect(chatCalls).toBe(2);
		expect(delivered).toEqual(["next result"]);
	});

	test("releases only retryable legacy pre-reply failures back to a leaseable state", async () => {
		const store = await createDurableStoreForJob();
		const job = await claimedTelegramJob(store, {
			updateId: "legacy-retry-1",
			text: "legacy retry please",
		});
		let agentCalls = 0;
		const replies: string[] = [];
		const appended: ConversationMessage[][] = [];
		const deps = processorDeps({
			telegramUpdateStore: store,
			orchestrator: {
				answer: async () => {
					agentCalls += 1;
					if (agentCalls === 1) {
						throw responsesError(true);
					}
					return "legacy recovered";
				},
			},
			telegramReplyClient: {
				reply: async (_chatId, text) => {
					replies.push(text);
				},
			},
			memoryStore: {
				read: async () => [],
				append: async (_sessionId, messages) => {
					appended.push(messages);
					return messages;
				},
				clear: async () => undefined,
			},
		});

		const attempts = await runQueueAttempts(job, deps, [1, 2]);

		expect(attempts).toEqual([
			{ acked: false, retries: 1 },
			{ acked: true, retries: 0 },
		]);
		expect(agentCalls).toBe(2);
		expect(replies).toEqual(["legacy recovered"]);
		expect(appended).toEqual([
			[
				{ role: "user", content: "legacy retry please" },
				{ role: "assistant", content: "legacy recovered" },
			],
		]);
	});

	test("does not reopen exhausted retryable legacy failures after terminal notification", async () => {
		const store = await createDurableStoreForJob();
		const job = await claimedTelegramJob(store, {
			updateId: "legacy-terminal-1",
			text: "legacy terminal please",
		});
		let agentCalls = 0;
		const replies: string[] = [];
		const deps = processorDeps({
			telegramUpdateStore: store,
			orchestrator: {
				answer: async () => {
					agentCalls += 1;
					throw responsesError(true);
				},
			},
			telegramReplyClient: {
				reply: async (_chatId, text) => {
					replies.push(text);
				},
			},
		});

		const attempts = await runQueueAttempts(job, deps, [3, 4]);

		expect(attempts).toEqual([
			{ acked: true, retries: 0 },
			{ acked: true, retries: 0 },
		]);
		expect(agentCalls).toBe(1);
		expect(replies).toHaveLength(1);
		expect(replies[0]).toContain("ระบบ AI มีคำขอหนาแน่น");
	});
});

function telegramJob(): TelegramJob {
	return {
		updateId: "790",
		chatId: 9001,
		messageId: 42,
		text: "list every custom rate limit",
		repository: "codemonday-dev/lms-backend",
		branch: "dev",
		question: "list every custom rate limit",
	};
}

function responsesError(retryable: boolean): ResponsesApiError {
	return new ResponsesApiError({
		status: 429,
		code: retryable ? "slow_down" : "credit_balance_exhausted",
		requestId: "req_test",
		attempts: retryable ? 3 : 1,
		retryable,
	});
}

function processorDeps(
	overrides: Partial<TelegramJobProcessorDeps>,
): TelegramJobProcessorDeps {
	return {
		config: loadLegacyTelegramConfig(),
		orchestrator: { answer: async () => "done" },
		memoryStore: {
			read: async () => [],
			append: async (_sessionId, messages) => messages,
			clear: async () => undefined,
		},
		telegramReplyClient: { reply: async () => undefined },
		telegramUpdateStore: {
			claim: async () => ({ claimed: true, duplicate: false }),
			dispatchLease: async () => ({ kind: "leased", record: record() }),
			complete: async () => undefined,
			fail: async () => undefined,
			markUncertain: async () => undefined,
			release: async () => undefined,
			retryPreReply: async () => undefined,
			beginReply: async () => ({ kind: "ready", record: record() }),
		},
		...overrides,
	};
}

function loadLegacyTelegramConfig() {
	return {
		port: 3000,
		runtime: { mode: "legacy" as const },
		line: { channelSecret: "", channelAccessToken: "", apiBaseUrl: "" },
		telegram: {
			botToken: "bot",
			webhookSecret: "secret",
			allowedUserIds: ["9001"],
			apiBaseUrl: "https://telegram.example",
		},
		discord: {
			applicationId: "",
			publicKey: "",
			botToken: "",
			gatewaySharedSecret: "",
			allowedUserIds: [],
			allowedGuildIds: [],
			apiBaseUrl: "https://discord.com/api/v10",
		},
		whatsapp: {
			accessToken: "",
			phoneNumberId: "",
			verifyToken: "",
			appSecret: "",
			apiBaseUrl: "",
		},
		llm: {
			apiKey: "openai",
			baseUrl: "https://api.openai.com/v1",
			model: "model",
			maxToolRounds: 1,
			maxToolCalls: 1,
		},
		github: {
			owner: "",
			repo: "",
			token: "github",
			ref: "main",
			apiBaseUrl: "https://api.github.com",
		},
		memory: { directory: ".sessions", maxMessages: 12 },
		hermes: {
			baseUrl: "",
			apiServerKey: "",
			telegramAllowedUserIds: [],
		},
	};
}

function loadHermesTelegramConfig() {
	return {
		...loadLegacyTelegramConfig(),
		runtime: { mode: "hermes" as const },
		hermes: {
			baseUrl: "https://hermes.internal",
			apiServerKey: "hermes-key",
			telegramAllowedUserIds: [],
		},
	};
}

function record() {
	return {
		version: 1 as const,
		status: "claimed" as const,
		key: "telegram:update:790",
		sessionSequence: 1,
		generation: "gen",
		providerSessionId: "telegram:chat:9001",
		canonicalInputHash: "hash",
		attemptCount: 1,
		expiresAt: new Date(Date.now() + 1_000).toISOString(),
	};
}

type QueueAttemptResult = { acked: boolean; retries: number };
type SqlValue = string | number | null;
type SqlResult<T> = {
	toArray(): T[];
	one(): T;
};

async function runQueueAttempts(
	job: TelegramJob,
	deps: TelegramJobProcessorDeps,
	attempts: number[],
): Promise<QueueAttemptResult[]> {
	const results: QueueAttemptResult[] = [];
	for (const attempt of attempts) {
		let acked = false;
		let retries = 0;
		await processTelegramQueueMessage(
			{
				body: job,
				attempts: attempt,
				ack: () => {
					acked = true;
				},
				retry: () => {
					retries += 1;
				},
			},
			deps,
		);
		results.push({ acked, retries });
	}
	return results;
}

async function claimedTelegramJob(
	store: Awaited<ReturnType<typeof createDurableStoreForJob>>,
	overrides: Partial<TelegramJob>,
): Promise<TelegramJob> {
	const job = {
		...telegramJob(),
		userId: "9001",
		providerSessionId: "telegram:chat:9001",
		idempotencyKey: `telegram:update:${overrides.updateId ?? "790"}`,
		...overrides,
		question: overrides.question ?? overrides.text ?? telegramJob().question,
	};
	const canonicalInputHash = await hashTestInput(job.text);
	const claim = await store.claim({
		providerSessionId: job.providerSessionId ?? "telegram:chat:9001",
		idempotencyKey: job.idempotencyKey ?? "telegram:update:790",
		canonicalInputHash,
		updateId: job.updateId,
		...(job.messageId !== undefined
			? { messageId: String(job.messageId) }
			: {}),
	});
	return {
		...job,
		canonicalInputHash,
		sessionSequence: claim.record?.sessionSequence,
		generation: claim.record?.generation,
	};
}

async function createDurableStoreForJob() {
	const [{ TelegramSessionCoordinator }] = await Promise.all([
		import("./session-coordinator"),
	]);
	const db = new Database(":memory:");
	const ctx = {
		storage: { sql: new SqlStorage(db) },
		blockConcurrencyWhile(callback: () => Promise<void>) {
			void callback();
		},
	} as unknown as DurableObjectState;
	const coordinator = new TelegramSessionCoordinator(ctx, {});
	return createDurableObjectTelegramUpdateStore({
		getByName: () => coordinator,
	});
}

class SqlStorage {
	constructor(private readonly db: Database) {}

	exec<T>(sql: string, ...params: SqlValue[]): SqlResult<T> {
		const trimmed = sql.trim();
		if (params.length === 0 && trimmed.includes(";")) {
			this.db.exec(trimmed);
			return emptySqlResult<T>();
		}
		if (/^(SELECT|PRAGMA)\b/i.test(trimmed)) {
			const statement = this.db.query(trimmed);
			return {
				toArray: () => statement.all(...params) as T[],
				one: () => {
					const row = statement.get(...params) as T | null;
					if (!row) {
						throw new Error("Expected one SQL row");
					}
					return row;
				},
			};
		}
		this.db.query(trimmed).run(...params);
		return emptySqlResult<T>();
	}
}

function emptySqlResult<T>(): SqlResult<T> {
	return {
		toArray: () => [],
		one: () => {
			throw new Error("Expected one SQL row");
		},
	};
}

async function hashTestInput(text: string): Promise<string> {
	const bytes = new TextEncoder().encode(text);
	const hash = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(hash)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}
