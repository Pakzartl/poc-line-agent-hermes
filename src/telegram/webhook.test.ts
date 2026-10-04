import { describe, expect, test } from "bun:test";
import { loadConfig } from "../config";
import type { SessionMemoryStore } from "../memory/types";
import type { TelegramJob } from "./job";
import { createTelegramReplyClient } from "./reply";
import type { TelegramCoordinatorRecord } from "./session-coordinator";
import { createMemoryTelegramSourceSelectionStore } from "./source-selection";
import type { TelegramUpdateStore } from "./update-store";
import { handleTelegramWebhook } from "./webhook";

describe("Telegram webhook", () => {
	test("verifies the webhook secret and enqueues an allowed message", async () => {
		const config = loadConfig({
			TELEGRAM_BOT_TOKEN: "bot-token",
			TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
			TELEGRAM_ALLOWED_USER_IDS: "9001",
		});
		const jobs: TelegramJob[] = [];

		const response = await handleTelegramWebhook(
			new Request("http://localhost/telegram/webhook", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Telegram-Bot-Api-Secret-Token": "webhook-secret",
				},
				body: JSON.stringify({
					message: {
						message_id: 42,
						text: scopedMessage("what was its commit?"),
						from: { id: 9001 },
						chat: { id: -1001 },
					},
				}),
			}),
			{
				config,
				memoryStore: emptyMemoryStore(),
				telegramJobQueue: {
					send: async (job) => {
						jobs.push(job);
					},
				},
				telegramReplyClient: { reply: async () => undefined },
				telegramUpdateStore: emptyUpdateStore(),
			},
		);

		expect(response.status).toBe(200);
		expect(await readResponseJson(response)).toEqual({
			ok: true,
			accepted: true,
		});
		expect(jobs).toEqual([
			expect.objectContaining({
				chatId: -1001,
				messageId: 42,
				text: scopedMessage("what was its commit?"),
				repository: "codemonday-dev/lms-backend",
				branch: "dev",
				question: "what was its commit?",
				idempotencyKey: "telegram:message:-1001:42",
				providerSessionId: "telegram:chat:source-v4:-1001",
			}),
		]);
	});

	test("sends an unscoped message to Hermes as general chat", async () => {
		const config = loadConfig({
			TELEGRAM_BOT_TOKEN: "bot-token",
			TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
			TELEGRAM_ALLOWED_USER_IDS: "9001",
		});
		const jobs: TelegramJob[] = [];
		const replies: unknown[][] = [];

		const response = await handleTelegramWebhook(
			telegramRequest({
				text: "learner gateway set rate limit ไว้เท่าไหร่",
				userId: 9001,
				chatId: 9001,
				updateId: 124,
			}),
			{
				config,
				memoryStore: emptyMemoryStore(),
				telegramJobQueue: {
					send: async (job) => {
						jobs.push(job);
					},
				},
				telegramReplyClient: {
					reply: async (...args) => {
						replies.push(args);
					},
				},
				telegramUpdateStore: emptyUpdateStore(),
			},
		);

		expect(response.status).toBe(200);
		expect(jobs).toEqual([
			expect.objectContaining({
				question: "learner gateway set rate limit ไว้เท่าไหร่",
				repository: "",
				branch: "",
			}),
		]);
		expect(replies).toHaveLength(0);
	});

	test("uses inline repo and branch options for /code before enqueueing", async () => {
		const config = loadConfig({
			TELEGRAM_BOT_TOKEN: "bot-token",
			TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
			TELEGRAM_ALLOWED_USER_IDS: "9001",
			GITHUB_TOKEN: "github-token",
		});
		const jobs: TelegramJob[] = [];
		const replies: unknown[][] = [];
		const answeredCallbacks: string[] = [];
		const sourceSelections = createMemoryTelegramSourceSelectionStore();
		const deps: Parameters<typeof handleTelegramWebhook>[1] = {
			config,
			memoryStore: emptyMemoryStore(),
			telegramJobQueue: {
				send: async (job) => {
					jobs.push(job);
				},
			},
			telegramReplyClient: {
				reply: async (...args) => {
					replies.push(args);
				},
				answerCallbackQuery: async (id) => {
					answeredCallbacks.push(id);
				},
			},
			telegramUpdateStore: emptyUpdateStore(),
			telegramSourceSelectionStore: sourceSelections,
			telegramCodeSourceClient: {
				listRepositories: async () => ["codemonday-dev/lms-backend"],
				listBranches: async () => ["dev", "main", "feature/picker"],
				branchExists: async () => true,
			},
		};

		await handleTelegramWebhook(
			telegramRequest({
				text: "/code learner gateway set rate limit ไว้เท่าไหร่",
				userId: 9001,
				chatId: 9001,
				updateId: 124,
			}),
			deps,
		);

		const repoCallback = callbackData(replies[0], 0, 0);
		expect(repoCallback).toMatch(/^cs:r:/);
		expect(jobs).toHaveLength(0);

		await handleTelegramWebhook(
			telegramCallbackRequest({
				data: repoCallback,
				callbackId: "repo-callback",
				userId: 9001,
				chatId: 9001,
				updateId: 125,
			}),
			deps,
		);

		const branchCallback = callbackData(replies[1], 0, 0);
		expect(branchCallback).toMatch(/^cs:b:/);

		await handleTelegramWebhook(
			telegramCallbackRequest({
				data: branchCallback,
				callbackId: "branch-callback",
				userId: 9001,
				chatId: 9001,
				updateId: 126,
			}),
			deps,
		);

		expect(answeredCallbacks).toEqual(["repo-callback", "branch-callback"]);
		expect(jobs).toEqual([
			expect.objectContaining({
				repository: "codemonday-dev/lms-backend",
				branch: "dev",
				question: "learner gateway set rate limit ไว้เท่าไหร่",
				messageId: 42,
			}),
		]);
	});

	test("treats a repeated repository click as idempotent", async () => {
		const config = loadConfig({
			TELEGRAM_BOT_TOKEN: "bot-token",
			TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
			TELEGRAM_ALLOWED_USER_IDS: "9001",
			GITHUB_TOKEN: "github-token",
		});
		const replies: unknown[][] = [];
		const answeredCallbacks: { id: string; text?: string }[] = [];
		const deps: Parameters<typeof handleTelegramWebhook>[1] = {
			config,
			memoryStore: emptyMemoryStore(),
			telegramJobQueue: { send: async () => undefined },
			telegramReplyClient: {
				reply: async (...args) => {
					replies.push(args);
				},
				answerCallbackQuery: async (id, text) => {
					answeredCallbacks.push({ id, ...(text ? { text } : {}) });
				},
			},
			telegramUpdateStore: emptyUpdateStore(),
			telegramSourceSelectionStore: createMemoryTelegramSourceSelectionStore(),
			telegramCodeSourceClient: {
				listRepositories: async () => ["codemonday-dev/lms-backend"],
				listBranches: async () => ["dev", "main"],
				branchExists: async () => true,
			},
		};

		await handleTelegramWebhook(
			telegramRequest({
				text: "/code draw architecture",
				userId: 9001,
				chatId: 9001,
				updateId: 200,
			}),
			deps,
		);
		const repoCallback = callbackData(replies[0], 0, 0);

		await handleTelegramWebhook(
			telegramCallbackRequest({
				data: repoCallback,
				callbackId: "repo-first",
				userId: 9001,
				chatId: 9001,
				updateId: 201,
			}),
			deps,
		);
		const repeated = await handleTelegramWebhook(
			telegramCallbackRequest({
				data: repoCallback,
				callbackId: "repo-second",
				userId: 9001,
				chatId: 9001,
				updateId: 202,
			}),
			deps,
		);

		expect(await readResponseJson(repeated)).toEqual({ ok: true });
		expect(replies).toHaveLength(3);
		expect(callbackData(replies[2], 0, 0)).toMatch(/^cs:b:/);
		expect(
			replies.some(
				(reply) =>
					reply[1] ===
					"ตัวเลือกนี้หมดอายุหรือถูกแทนที่แล้ว กรุณาเริ่มใหม่ด้วย /code ตามด้วยคำถาม",
			),
		).toBe(false);
		expect(answeredCallbacks).toEqual([
			{ id: "repo-first", text: "กำลังโหลด branch…" },
			{ id: "repo-second", text: "กำลังโหลด branch…" },
		]);
	});

	test("keeps two overlapping code pickers usable in the same chat", async () => {
		const config = loadConfig({
			TELEGRAM_BOT_TOKEN: "bot-token",
			TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
			TELEGRAM_ALLOWED_USER_IDS: "9001",
			GITHUB_TOKEN: "github-token",
		});
		const replies: unknown[][] = [];
		const jobs: TelegramJob[] = [];
		const deps: Parameters<typeof handleTelegramWebhook>[1] = {
			config,
			memoryStore: emptyMemoryStore(),
			telegramJobQueue: {
				send: async (job) => {
					jobs.push(job);
				},
			},
			telegramReplyClient: {
				reply: async (...args) => {
					replies.push(args);
				},
				answerCallbackQuery: async () => undefined,
			},
			telegramUpdateStore: emptyUpdateStore(),
			telegramSourceSelectionStore: createMemoryTelegramSourceSelectionStore(),
			telegramCodeSourceClient: {
				listRepositories: async () => ["codemonday-dev/lms-backend"],
				listBranches: async () => ["dev"],
				branchExists: async () => true,
			},
		};

		await handleTelegramWebhook(
			telegramRequest({
				text: "/code first question",
				userId: 9001,
				chatId: 9001,
				updateId: 300,
			}),
			deps,
		);
		await handleTelegramWebhook(
			telegramRequest({
				text: "/code second question",
				userId: 9001,
				chatId: 9001,
				updateId: 301,
			}),
			deps,
		);
		const firstRepo = callbackData(replies[0], 0, 0);
		const secondRepo = callbackData(replies[1], 0, 0);

		await handleTelegramWebhook(
			telegramCallbackRequest({
				data: firstRepo,
				callbackId: "first-repo",
				userId: 9001,
				chatId: 9001,
				updateId: 302,
			}),
			deps,
		);
		await handleTelegramWebhook(
			telegramCallbackRequest({
				data: secondRepo,
				callbackId: "second-repo",
				userId: 9001,
				chatId: 9001,
				updateId: 303,
			}),
			deps,
		);

		await handleTelegramWebhook(
			telegramCallbackRequest({
				data: callbackData(replies[2], 0, 0),
				callbackId: "first-branch",
				userId: 9001,
				chatId: 9001,
				updateId: 304,
			}),
			deps,
		);
		await handleTelegramWebhook(
			telegramCallbackRequest({
				data: callbackData(replies[3], 0, 0),
				callbackId: "second-branch",
				userId: 9001,
				chatId: 9001,
				updateId: 305,
			}),
			deps,
		);

		expect(jobs.map((job) => job.question)).toEqual([
			"first question",
			"second question",
		]);
	});

	test("paginates the repositories visible to the GitHub token", async () => {
		const config = loadConfig({
			TELEGRAM_BOT_TOKEN: "bot-token",
			TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
			TELEGRAM_ALLOWED_USER_IDS: "9001",
			GITHUB_TOKEN: "github-token",
		});
		const replies: unknown[][] = [];
		const deps: Parameters<typeof handleTelegramWebhook>[1] = {
			config,
			memoryStore: emptyMemoryStore(),
			telegramJobQueue: { send: async () => undefined },
			telegramReplyClient: {
				reply: async (...args) => {
					replies.push(args);
				},
				answerCallbackQuery: async () => undefined,
			},
			telegramUpdateStore: emptyUpdateStore(),
			telegramSourceSelectionStore: createMemoryTelegramSourceSelectionStore(),
			telegramCodeSourceClient: {
				listRepositories: async () =>
					Array.from({ length: 9 }, (_, index) => `example/repo-${index}`),
				listBranches: async () => ["main"],
				branchExists: async () => true,
			},
		};

		await handleTelegramWebhook(
			telegramRequest({
				text: "/code inspect repo",
				userId: 9001,
				chatId: 9001,
				updateId: 400,
			}),
			deps,
		);
		const nextPage = callbackData(replies[0], 8, 0);
		expect(nextPage).toMatch(/^cs:q:/);

		await handleTelegramWebhook(
			telegramCallbackRequest({
				data: nextPage,
				callbackId: "repo-page-two",
				userId: 9001,
				chatId: 9001,
				updateId: 401,
			}),
			deps,
		);

		expect(callbackData(replies[1], 0, 0)).toMatch(/^cs:r:.*:8$/);
	});

	test("denies users outside the allowlist before memory or the agent", async () => {
		const config = loadConfig({
			TELEGRAM_BOT_TOKEN: "bot-token",
			TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
			TELEGRAM_ALLOWED_USER_IDS: "9001",
		});
		let queueCalls = 0;
		let clearCalls = 0;
		const replies: unknown[][] = [];

		const response = await handleTelegramWebhook(
			telegramRequest({ text: "/clear", userId: 777, chatId: 777 }),
			{
				config,
				memoryStore: {
					...emptyMemoryStore(),
					clear: async () => {
						clearCalls += 1;
					},
				},
				telegramJobQueue: {
					send: async () => {
						queueCalls += 1;
					},
				},
				telegramReplyClient: {
					reply: async (...args) => {
						replies.push(args);
					},
				},
				telegramUpdateStore: emptyUpdateStore(),
			},
		);

		expect(response.status).toBe(200);
		expect(queueCalls).toBe(0);
		expect(clearCalls).toBe(0);
		expect(replies).toEqual([
			[777, "Access denied. Your Telegram user ID is: 777", 42],
		]);
	});

	test("returns the sender ID for /whoami without using memory or the agent", async () => {
		const config = loadConfig({
			TELEGRAM_BOT_TOKEN: "bot-token",
			TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
		});
		let queueCalls = 0;
		const replies: unknown[][] = [];

		await handleTelegramWebhook(
			telegramRequest({ text: "/whoami", userId: 8123, chatId: 8123 }),
			{
				config,
				memoryStore: emptyMemoryStore(),
				telegramJobQueue: {
					send: async () => {
						queueCalls += 1;
					},
				},
				telegramReplyClient: {
					reply: async (...args) => {
						replies.push(args);
					},
				},
				telegramUpdateStore: emptyUpdateStore(),
			},
		);

		expect(queueCalls).toBe(0);
		expect(replies).toEqual([[8123, "Your Telegram user ID is: 8123", 42]]);
	});

	test("clears the current chat conversation without enqueueing the agent", async () => {
		const config = loadConfig({
			TELEGRAM_BOT_TOKEN: "bot-token",
			TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
			TELEGRAM_ALLOWED_USER_IDS: "9001",
		});
		const clearedSessions: string[] = [];
		const replies: unknown[][] = [];
		let queueCalls = 0;

		const response = await handleTelegramWebhook(
			telegramRequest({
				text: "/clear@megalodon_agent_bot",
				userId: 9001,
				chatId: -1001,
				updateId: 122,
			}),
			{
				config,
				memoryStore: {
					read: async () => [],
					append: async (_sessionId, messages) => messages,
					clear: async (sessionId) => {
						clearedSessions.push(sessionId);
					},
				},
				telegramJobQueue: {
					send: async () => {
						queueCalls += 1;
					},
				},
				telegramReplyClient: {
					reply: async (...args) => {
						replies.push(args);
					},
				},
				telegramUpdateStore: emptyUpdateStore(),
			},
		);

		expect(response.status).toBe(200);
		expect(await readResponseJson(response)).toEqual({ ok: true });
		expect(clearedSessions).toEqual(["telegram:chat:source-v4:-1001"]);
		expect(queueCalls).toBe(0);
		expect(replies).toEqual([
			[
				-1001,
				"Conversation cleared. Your next message will start a new session.",
				42,
			],
		]);
	});

	test("clears Hermes session state for routed Telegram users", async () => {
		const config = loadConfig({
			AGENT_RUNTIME: "hermes",
			TELEGRAM_BOT_TOKEN: "bot-token",
			TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
			TELEGRAM_ALLOWED_USER_IDS: "9001",
			HERMES_BASE_URL: "https://hermes.internal",
			HERMES_API_SERVER_KEY: "hermes-key",
		});
		const clearedHermes: string[] = [];
		const clearedLegacy: string[] = [];
		const replies: unknown[][] = [];

		const response = await handleTelegramWebhook(
			telegramRequest({
				text: "/clear",
				userId: 9001,
				chatId: 9001,
				updateId: 1234,
			}),
			{
				config,
				memoryStore: {
					...emptyMemoryStore(),
					clear: async (sessionId) => {
						clearedLegacy.push(sessionId);
					},
				},
				telegramJobQueue: { send: async () => undefined },
				telegramReplyClient: {
					reply: async (...args) => {
						replies.push(args);
					},
				},
				telegramUpdateStore: emptyUpdateStore(),
				hermesClient: {
					chat: async () => ({ text: "unused" }),
					listMessages: async () => [],
					lastMessageMarker: async () => undefined,
					clearSession: async (sessionId) => {
						clearedHermes.push(sessionId);
					},
				},
			},
		);

		expect(response.status).toBe(200);
		expect(clearedHermes).toEqual(["telegram:chat:source-v4:9001"]);
		expect(clearedLegacy).toEqual(["telegram:chat:source-v4:9001"]);
		expect(replies[0]?.[1]).toBe(
			"Conversation cleared. Your next message will start a new session.",
		);
	});

	test("reports Hermes clear failures without claiming success", async () => {
		const config = loadConfig({
			AGENT_RUNTIME: "hermes",
			TELEGRAM_BOT_TOKEN: "bot-token",
			TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
			TELEGRAM_ALLOWED_USER_IDS: "9001",
			HERMES_BASE_URL: "https://hermes.internal",
			HERMES_API_SERVER_KEY: "hermes-key",
		});
		let legacyClearCalls = 0;
		const replies: unknown[][] = [];

		await handleTelegramWebhook(
			telegramRequest({
				text: "/clear",
				userId: 9001,
				chatId: 9001,
				updateId: 1235,
			}),
			{
				config,
				memoryStore: {
					...emptyMemoryStore(),
					clear: async () => {
						legacyClearCalls += 1;
					},
				},
				telegramJobQueue: { send: async () => undefined },
				telegramReplyClient: {
					reply: async (...args) => {
						replies.push(args);
					},
				},
				telegramUpdateStore: emptyUpdateStore(),
				hermesClient: {
					chat: async () => ({ text: "unused" }),
					listMessages: async () => [],
					lastMessageMarker: async () => undefined,
					clearSession: async () => {
						throw new Error("Hermes unavailable");
					},
				},
			},
		);

		expect(legacyClearCalls).toBe(0);
		expect(replies[0]?.[1]).toBe(
			"Could not clear the Hermes conversation. Please try again later.",
		);
	});

	test("rejects a missing or invalid webhook secret", async () => {
		const config = loadConfig({
			TELEGRAM_BOT_TOKEN: "bot-token",
			TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
		});
		const response = await handleTelegramWebhook(
			new Request("http://localhost/telegram/webhook", {
				method: "POST",
				body: "{}",
			}),
			{
				config,
				memoryStore: emptyMemoryStore(),
				telegramJobQueue: { send: async () => undefined },
				telegramReplyClient: { reply: async () => undefined },
				telegramUpdateStore: emptyUpdateStore(),
			},
		);

		expect(response.status).toBe(401);
	});

	test("acknowledges duplicate updates without calling the agent or replying", async () => {
		const config = loadConfig({
			TELEGRAM_BOT_TOKEN: "bot-token",
			TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
			TELEGRAM_ALLOWED_USER_IDS: "9001",
		});
		let queueCalls = 0;
		let replyCalls = 0;

		const response = await handleTelegramWebhook(
			telegramRequest({
				text: "list repositories",
				userId: 9001,
				chatId: 9001,
				updateId: 123,
			}),
			{
				config,
				memoryStore: emptyMemoryStore(),
				telegramJobQueue: {
					send: async () => {
						queueCalls += 1;
					},
				},
				telegramReplyClient: {
					reply: async () => {
						replyCalls += 1;
					},
				},
				telegramUpdateStore: {
					claim: async (input) => ({
						claimed: input.updateId !== "123",
						duplicate: input.updateId === "123",
						record: record(),
					}),
					dispatchLease: async () => ({ kind: "leased", record: record() }),
					complete: async () => undefined,
					fail: async () => undefined,
					markUncertain: async () => undefined,
					release: async () => undefined,
					retryPreReply: async () => undefined,
					beginReply: async () => ({ kind: "ready", record: record() }),
				},
			},
		);

		expect(response.status).toBe(200);
		expect(await readResponseJson(response)).toEqual({
			ok: true,
			duplicate: true,
		});
		expect(queueCalls).toBe(0);
		expect(replyCalls).toBe(0);
	});

	test("claims an update before enqueueing so webhook retries are deduplicated", async () => {
		const config = loadConfig({
			TELEGRAM_BOT_TOKEN: "bot-token",
			TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
			TELEGRAM_ALLOWED_USER_IDS: "9001",
		});
		const claimed = new Set<string>();
		let releaseQueue: (() => void) | undefined;
		const queueGate = new Promise<void>((resolve) => {
			releaseQueue = resolve;
		});
		let queueCalls = 0;
		let replyCalls = 0;
		const deps: Parameters<typeof handleTelegramWebhook>[1] = {
			config,
			memoryStore: emptyMemoryStore(),
			telegramJobQueue: {
				send: async () => {
					queueCalls += 1;
					await queueGate;
				},
			},
			telegramReplyClient: {
				reply: async () => {
					replyCalls += 1;
				},
			},
			telegramUpdateStore: {
				claim: async (input) => {
					if (claimed.has(input.idempotencyKey)) {
						return { claimed: false, duplicate: true };
					}
					claimed.add(input.idempotencyKey);
					return { claimed: true, duplicate: false, record: record() };
				},
				dispatchLease: async () => ({ kind: "leased", record: record() }),
				complete: async () => undefined,
				fail: async () => undefined,
				markUncertain: async () => undefined,
				release: async (input) => {
					claimed.delete(input.idempotencyKey);
				},
				retryPreReply: async () => undefined,
				beginReply: async () => ({ kind: "ready", record: record() }),
			},
		};
		const requestInput = {
			text: scopedMessage("explain the repository"),
			userId: 9001,
			chatId: 9001,
			updateId: 789,
		};

		const firstResponse = handleTelegramWebhook(
			telegramRequest(requestInput),
			deps,
		);
		await Promise.resolve();
		const duplicateResponse = await handleTelegramWebhook(
			telegramRequest(requestInput),
			deps,
		);

		expect(await readResponseJson(duplicateResponse)).toEqual({
			ok: true,
			duplicate: true,
		});
		expect(queueCalls).toBe(1);
		releaseQueue?.();
		expect((await firstResponse).status).toBe(200);
		expect(replyCalls).toBe(0);
	});

	test("acknowledges a long-running update as soon as the queue accepts it", async () => {
		const config = loadConfig({
			TELEGRAM_BOT_TOKEN: "bot-token",
			TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
			TELEGRAM_ALLOWED_USER_IDS: "9001",
		});
		const jobs: TelegramJob[] = [];

		const response = await handleTelegramWebhook(
			telegramRequest({
				text: scopedMessage("list every custom rate limit"),
				userId: 9001,
				chatId: 9001,
				updateId: 790,
			}),
			{
				config,
				memoryStore: emptyMemoryStore(),
				telegramJobQueue: {
					send: async (job) => {
						jobs.push(job);
					},
				},
				telegramReplyClient: { reply: async () => undefined },
				telegramUpdateStore: emptyUpdateStore(),
			},
		);

		expect(response.status).toBe(200);
		expect(await readResponseJson(response)).toEqual({
			ok: true,
			accepted: true,
		});
		expect(jobs).toHaveLength(1);
	});

	test("releases the update claim when enqueueing fails", async () => {
		const config = loadConfig({
			TELEGRAM_BOT_TOKEN: "bot-token",
			TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
			TELEGRAM_ALLOWED_USER_IDS: "9001",
		});
		const released: string[] = [];

		const error = await handleTelegramWebhook(
			telegramRequest({
				text: scopedMessage("list every custom rate limit"),
				userId: 9001,
				chatId: 9001,
				updateId: 791,
			}),
			{
				config,
				memoryStore: emptyMemoryStore(),
				telegramJobQueue: {
					send: async () => {
						throw new Error("queue unavailable");
					},
				},
				telegramReplyClient: { reply: async () => undefined },
				telegramUpdateStore: {
					claim: async () => ({
						claimed: true,
						duplicate: false,
						record: record(),
					}),
					dispatchLease: async () => ({ kind: "leased", record: record() }),
					complete: async () => undefined,
					fail: async () => undefined,
					markUncertain: async () => undefined,
					release: async (updateId) => {
						released.push(updateId.idempotencyKey);
					},
					retryPreReply: async () => undefined,
					beginReply: async () => ({ kind: "ready", record: record() }),
				},
			},
		).catch((caught) => caught);

		expect(error).toEqual(new Error("queue unavailable"));
		expect(released).toEqual(["telegram:update:791"]);
	});

	test("sends messages through the Telegram Bot API", async () => {
		let request: Request | undefined;
		const client = createTelegramReplyClient({
			botToken: "secret-bot-token",
			apiBaseUrl: "https://telegram.example",
			fetch: Object.assign(
				async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
					request = new Request(input, init);
					return Response.json({ ok: true });
				},
				{ preconnect: fetch.preconnect },
			),
		});

		await client.reply("chat-1", "hello", 7);

		expect(request?.url).toBe(
			"https://telegram.example/botsecret-bot-token/sendMessage",
		);
		expect(await requestJson(request)).toEqual({
			chat_id: "chat-1",
			text: "hello",
			parse_mode: "HTML",
			reply_parameters: { message_id: 7 },
		});
	});

	test("falls back to readable plain text when Telegram rejects formatting", async () => {
		const bodies: Record<string, unknown>[] = [];
		const client = createTelegramReplyClient({
			botToken: "secret-bot-token",
			apiBaseUrl: "https://telegram.example",
			fetch: Object.assign(
				async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
					const request = new Request(input, init);
					bodies.push((await request.json()) as Record<string, unknown>);
					return bodies.length === 1
						? Response.json({ ok: false }, { status: 400 })
						: Response.json({ ok: true });
				},
				{ preconnect: fetch.preconnect },
			),
		});

		await client.reply("chat-1", "# Title\n**Bold** and `code`", 7);

		expect(bodies).toEqual([
			{
				chat_id: "chat-1",
				text: "<b>Title</b>\n<b>Bold</b> and <code>code</code>",
				parse_mode: "HTML",
				reply_parameters: { message_id: 7 },
			},
			{
				chat_id: "chat-1",
				text: "Title\nBold and code",
				reply_parameters: { message_id: 7 },
			},
		]);
	});

	test("answers inline keyboard callbacks through the Telegram Bot API", async () => {
		let request: Request | undefined;
		const client = createTelegramReplyClient({
			botToken: "secret-bot-token",
			apiBaseUrl: "https://telegram.example",
			fetch: Object.assign(
				async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
					request = new Request(input, init);
					return Response.json({ ok: true });
				},
				{ preconnect: fetch.preconnect },
			),
		});

		await client.answerCallbackQuery?.("callback-1");

		expect(request?.url).toBe(
			"https://telegram.example/botsecret-bot-token/answerCallbackQuery",
		);
		expect(await requestJson(request)).toEqual({
			callback_query_id: "callback-1",
		});
	});
});

function telegramRequest(input: {
	text: string;
	userId: number;
	chatId: number;
	updateId?: number;
}): Request {
	return new Request("http://localhost/telegram/webhook", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Telegram-Bot-Api-Secret-Token": "webhook-secret",
		},
		body: JSON.stringify({
			update_id: input.updateId,
			message: {
				message_id: 42,
				text: input.text,
				from: { id: input.userId },
				chat: { id: input.chatId },
			},
		}),
	});
}

function telegramCallbackRequest(input: {
	data: string;
	callbackId: string;
	userId: number;
	chatId: number;
	updateId: number;
}): Request {
	return new Request("http://localhost/telegram/webhook", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Telegram-Bot-Api-Secret-Token": "webhook-secret",
		},
		body: JSON.stringify({
			update_id: input.updateId,
			callback_query: {
				id: input.callbackId,
				data: input.data,
				from: { id: input.userId },
				message: {
					message_id: 99,
					chat: { id: input.chatId },
				},
			},
		}),
	});
}

function callbackData(
	reply: unknown[] | undefined,
	row: number,
	column: number,
): string {
	const options = reply?.[3] as
		| {
				replyMarkup?: {
					inline_keyboard?: { callback_data?: string }[][];
				};
		  }
		| undefined;
	const value =
		options?.replyMarkup?.inline_keyboard?.[row]?.[column]?.callback_data;
	if (!value) {
		throw new Error("Expected callback data");
	}
	return value;
}

function scopedMessage(question: string): string {
	return `repo: codemonday-dev/lms-backend\nbranch: dev\n${question}`;
}

async function readResponseJson(response: Response): Promise<unknown> {
	return response.json();
}

async function requestJson(request: Request | undefined): Promise<unknown> {
	if (!request) {
		throw new Error("Expected request to be captured");
	}
	return request.json();
}

function emptyUpdateStore(): TelegramUpdateStore {
	return {
		claim: async () => ({ claimed: true, duplicate: false, record: record() }),
		dispatchLease: async () => ({ kind: "leased", record: record() }),
		complete: async () => undefined,
		fail: async () => undefined,
		markUncertain: async () => undefined,
		release: async () => undefined,
		retryPreReply: async () => undefined,
		beginReply: async () => ({ kind: "ready", record: record() }),
	};
}

function emptyMemoryStore(): SessionMemoryStore {
	return {
		read: async () => [],
		append: async (_sessionId, messages) => messages,
		clear: async () => undefined,
	};
}

function record(): TelegramCoordinatorRecord {
	return {
		version: 1 as const,
		status: "claimed" as const,
		key: "telegram:update:123",
		sessionSequence: 1,
		generation: "gen",
		providerSessionId: "telegram:chat:9001",
		canonicalInputHash: "hash",
		attemptCount: 0,
		expiresAt: new Date(Date.now() + 1_000).toISOString(),
	};
}
