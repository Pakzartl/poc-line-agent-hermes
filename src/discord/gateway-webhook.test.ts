import { describe, expect, test } from "bun:test";
import { createMemoryCapabilityJobStore } from "../capabilities/job-store";
import { loadConfig } from "../config";
import type {
	IntentRouterDecision,
	RoutedIntent,
} from "../intent-router/client";
import { createMemoryTelegramSourceSelectionStore } from "../telegram/source-selection";
import { createPassThroughTelegramUpdateStore } from "../telegram/update-store";
import { createDiscordGatewaySignature } from "./gateway-signature";
import {
	type DiscordGatewayMessage,
	type DiscordGatewayWebhookDeps,
	handleDiscordGatewayMessage,
	processDiscordIntentMessage,
} from "./gateway-webhook";
import type { DiscordJob } from "./job";

const sharedSecret = "gateway-secret-which-is-long-enough";

describe("Discord Gateway webhook", () => {
	test("manual news selection preserves the question and never lists repositories", async () => {
		const jobs: DiscordJob[] = [];
		const replies: Reply[] = [];
		const deps = routedDeps("news", jobs, replies);
		let calls = 0;
		deps.classifyIntent = async () => {
			calls++;
			return { kind: "clarify", reason: "unavailable" };
		};
		deps.discordCodeSourceClient.listRepositories = async () => {
			throw new Error("must not list repositories");
		};
		const question = "หาข่าวน้ำท่วมอยุธยาวันนี้ (06/10/2026)";
		await send(
			deps,
			gatewayMessage({ content: `<@900001> ${question}`, botMentioned: true }),
		);
		expect(replies.at(-1)?.text).not.toContain("ยังไม่เปิดใช้งาน");
		await send(deps, gatewayMessage({ messageId: "1000002", content: "2" }));
		expect(calls).toBe(1);
		expect(jobs).toHaveLength(1);
		expect(jobs[0]).toMatchObject({ action: "news", question });
		await send(deps, gatewayMessage({ messageId: "1000003", content: "2" }));
		expect(jobs).toHaveLength(1);
	});
	test("bounds streaming payloads even without Content-Length", async () => {
		const result = await handleDiscordGatewayMessage(
			new Request("https://agent.example/discord/gateway/messages", {
				method: "POST",
				body: "x".repeat(64001),
			}),
			testDeps([], []),
		);
		expect(result.status).toBe(413);
	});
	test("queues fresh mentions without waiting for inference and leaves slash text alone", async () => {
		const deps = routedDeps("code", [], []);
		const pending: DiscordGatewayMessage[] = [];
		let calls = 0;
		deps.classifyIntent = async () => {
			calls++;
			throw new Error("must not run in ingress");
		};
		deps.discordIntentQueue = {
			send: async (message) => {
				pending.push(message);
			},
		};
		const message = gatewayMessage({
			content: "<@900001> ดูโค้ด",
			botMentioned: true,
		});
		expect((await send(deps, message)).status).toBe(202);
		expect(pending).toEqual([message]);
		expect(calls).toBe(0);
		await send(
			deps,
			gatewayMessage({ content: "<@900001> /code test", botMentioned: true }),
		);
		expect(pending).toHaveLength(1);
	});

	test("routes code then preserves the original question through mentioned repo and branch answers", async () => {
		const jobs: DiscordJob[] = [];
		const replies: Reply[] = [];
		const deps = routedDeps("code", jobs, replies);
		let calls = 0;
		deps.classifyIntent = async (question) => {
			calls++;
			expect(question).toBe("หา bug login");
			return route("code");
		};
		await send(
			deps,
			gatewayMessage({ content: "<@900001> หา bug login", botMentioned: true }),
		);
		expect(replies.at(-1)?.text).toContain("เลือก repository");
		await send(
			deps,
			gatewayMessage({
				messageId: "1000002",
				content: "<@900001> lms-backend",
				botMentioned: true,
			}),
		);
		await send(
			deps,
			gatewayMessage({
				messageId: "1000003",
				content: "<@900001> dev",
				botMentioned: true,
			}),
		);
		expect(calls).toBe(1);
		expect(jobs[0]?.question).toBe("หา bug login");
		expect(jobs[0]?.capability?.kind).toBe("code_investigation");
	});

	test("routes general chat to the existing chat queue without GitHub access or capabilities", async () => {
		const jobs: DiscordJob[] = [];
		const replies: Reply[] = [];
		const deps = routedDeps("general", jobs, replies);
		deps.discordCodeSourceClient.listRepositories = async () => {
			throw new Error("must not list repos");
		};
		await send(
			deps,
			gatewayMessage({ content: "<@900001> สวัสดีครับ", botMentioned: true }),
		);
		expect(jobs).toHaveLength(1);
		expect(jobs[0]).toMatchObject({
			action: "chat",
			text: "สวัสดีครับ",
			delivery: "channel",
		});
		expect(jobs[0]?.repository).toBeUndefined();
		expect(jobs[0]?.capability).toBeUndefined();
	});

	test("queues news separately without GitHub access or a code job", async () => {
		const jobs: DiscordJob[] = [];
		const replies: Reply[] = [];
		const deps = routedDeps("news", jobs, replies);
		deps.discordCodeSourceClient.listRepositories = async () => {
			throw new Error("must not list repos");
		};
		await send(
			deps,
			gatewayMessage({ content: "<@900001> หาข่าวน้ำท่วม", botMentioned: true }),
		);
		expect(jobs).toHaveLength(1);
		expect(jobs[0]).toMatchObject({
			action: "news",
			text: "หาข่าวน้ำท่วม",
			question: "หาข่าวน้ำท่วม",
		});
		expect(jobs[0]?.providerSessionId).toStartWith("discord:research:");
		expect(jobs[0]?.repository).toBeUndefined();
		expect(replies.at(-1)?.text).toContain("กำลังค้นเว็บและสรุปข้อมูล");
	});

	test.each([
		"low-confidence",
		"unavailable",
		"invalid-response",
		"ambiguous",
	] as const)("offers manual selection for %s and preserves original question", async (reason) => {
		const jobs: DiscordJob[] = [];
		const replies: Reply[] = [];
		const deps = routedDeps("code", jobs, replies);
		let calls = 0;
		deps.classifyIntent = async () => {
			calls++;
			return { kind: "clarify", reason };
		};
		await send(
			deps,
			gatewayMessage({
				content: "<@900001> หารายละเอียดให้หน่อย",
				botMentioned: true,
			}),
		);
		expect(replies.at(-1)?.text).toContain("1. code");
		await send(deps, gatewayMessage({ messageId: "1000002", content: "3" }));
		expect(calls).toBe(1);
		expect(jobs[0]?.text).toBe("หารายละเอียดให้หน่อย");
		await send(deps, gatewayMessage({ messageId: "1000003", content: "3" }));
		expect(jobs).toHaveLength(1);
	});

	test("a fresh mention replaces a stale intent picker and runs routing again", async () => {
		const jobs: DiscordJob[] = [];
		const replies: Reply[] = [];
		const deps = routedDeps("news", jobs, replies);
		let calls = 0;
		deps.classifyIntent = async (question) => {
			calls++;
			if (calls === 1) return { kind: "clarify", reason: "low-confidence" };
			expect(question).toBe("ถ้าจะเดินทางไปน่านวันที่ 10/10/2026 มีความเสี่ยงน้ำท่วมไหม");
			return route("news");
		};

		await send(
			deps,
			gatewayMessage({
				content: "<@900001> ช่วยดูเรื่องนี้ให้หน่อย",
				botMentioned: true,
			}),
		);
		expect(replies.at(-1)?.text).toContain("1. code");

		await send(
			deps,
			gatewayMessage({
				messageId: "1000002",
				content: "<@900001> ถ้าจะเดินทางไปน่านวันที่ 10/10/2026 มีความเสี่ยงน้ำท่วมไหม",
				botMentioned: true,
			}),
		);

		expect(calls).toBe(2);
		expect(jobs).toHaveLength(1);
		expect(jobs[0]).toMatchObject({
			action: "news",
			question: "ถ้าจะเดินทางไปน่านวันที่ 10/10/2026 มีความเสี่ยงน้ำท่วมไหม",
		});
	});

	test("manual code selection, invalid choice, cancellation, and outage never reinfer answers", async () => {
		const jobs: DiscordJob[] = [];
		const replies: Reply[] = [];
		const deps = routedDeps("code", jobs, replies);
		let calls = 0;
		deps.classifyIntent = async () => {
			calls++;
			throw new Error("offline");
		};
		await send(
			deps,
			gatewayMessage({
				content: "<@900001> ตรวจการ login",
				botMentioned: true,
			}),
		);
		await send(deps, gatewayMessage({ messageId: "1000002", content: "???" }));
		expect(replies.at(-1)?.text).toContain("1. code");
		await send(deps, gatewayMessage({ messageId: "1000003", content: "code" }));
		expect(replies.at(-1)?.text).toContain("เลือก repository");
		await send(
			deps,
			gatewayMessage({ messageId: "1000004", content: "ยกเลิก" }),
		);
		expect(replies.at(-1)?.text).toContain("ยกเลิก");
		expect(calls).toBe(1);
		expect(jobs).toHaveLength(0);
	});

	test("authorization and signature checks run before classifier or routing enqueue", async () => {
		const deps = routedDeps("general", [], []);
		deps.classifyIntent = async () => {
			throw new Error("must not classify");
		};
		deps.discordIntentQueue = {
			send: async () => {
				throw new Error("must not enqueue");
			},
		};
		expect(
			(
				await send(
					deps,
					gatewayMessage({ userId: "999999", botMentioned: true }),
				)
			).status,
		).toBe(204);
		expect(
			(
				await send(
					deps,
					gatewayMessage({ guildId: "999999", botMentioned: true }),
				)
			).status,
		).toBe(204);
		expect(
			(
				await handleDiscordGatewayMessage(
					new Request("https://agent.example/discord/gateway/messages", {
						method: "POST",
						body: "{}",
					}),
					deps,
				)
			).status,
		).toBe(401);
	});

	test("routing queue suppresses duplicate deliveries and rechecks authorization", async () => {
		const replies: Reply[] = [];
		const deps = routedDeps("news", [], replies);
		let calls = 0;
		const seen = new Set<string>();
		const originalClaim = deps.discordUpdateStore.claim;
		deps.discordUpdateStore.claim = async (input) => {
			if (seen.has(input.idempotencyKey))
				return { claimed: false, duplicate: true };
			seen.add(input.idempotencyKey);
			return originalClaim(input);
		};
		deps.classifyIntent = async () => {
			calls++;
			return route("news");
		};
		const message = gatewayMessage({
			content: "<@900001> หาข่าว",
			botMentioned: true,
		});
		await processDiscordIntentMessage(message, deps);
		await processDiscordIntentMessage(message, deps);
		await processDiscordIntentMessage(
			{ ...message, userId: "999999", messageId: "1000002" },
			deps,
		);
		expect(calls).toBe(1);
		expect(replies).toHaveLength(1);
	});

	test("does not overwrite a flow started while inference is pending", async () => {
		const replies: Reply[] = [];
		const deps = routedDeps("general", [], replies);
		deps.classifyIntent = async () => {
			await deps.discordSourceSelectionStore.begin({
				providerSessionId: "discord:channel:source-v1:600001:500001:700001",
				userId: "700001",
				question: "new question",
				repositories: ["owner/new"],
			});
			return route("general");
		};
		await processDiscordIntentMessage(
			gatewayMessage({ content: "<@900001> hi", botMentioned: true }),
			deps,
		);
		expect(replies).toHaveLength(0);
	});

	test("releases a failed general enqueue and reports it without selecting a repository", async () => {
		const replies: Reply[] = [];
		const deps = routedDeps("general", [], replies);
		let released = false;
		deps.discordUpdateStore.release = async () => {
			released = true;
		};
		deps.discordJobQueue.send = async () => {
			throw new Error("queue down");
		};
		await send(
			deps,
			gatewayMessage({ content: "<@900001> hi", botMentioned: true }),
		);
		expect(released).toBe(true);
		expect(replies.at(-1)?.text).toContain("ส่งงานไม่สำเร็จ");
	});

	test("keeps ordinary chat quiet and completes mention to repo to branch flow", async () => {
		const jobs: DiscordJob[] = [];
		const replies: { channelId: string; text: string; messageId?: string }[] =
			[];
		const deps = testDeps(jobs, replies);
		const capabilityStore = createMemoryCapabilityJobStore();
		deps.capabilityJobStore = capabilityStore;

		const ignored = await send(
			deps,
			gatewayMessage({ content: "คุยกันต่อได้เลย", botMentioned: false }),
		);
		expect(ignored.status).toBe(204);
		expect(replies).toHaveLength(0);

		const started = await send(
			deps,
			gatewayMessage({
				messageId: "1000002",
				content: "<@900001> หา issue rate limit ให้หน่อย",
				botMentioned: true,
			}),
		);
		expect(started.status).toBe(202);
		expect(replies.at(-1)?.text).toContain("codemonday-dev/lms-backend");

		await send(
			deps,
			gatewayMessage({
				messageId: "1000003",
				content: "lms-backend",
				botMentioned: false,
			}),
		);
		expect(replies.at(-1)?.text).toContain("เลือก branch");
		expect(replies.at(-1)?.text).toContain("dev");

		const queued = await send(
			deps,
			gatewayMessage({
				messageId: "1000004",
				content: "dev",
				botMentioned: false,
			}),
		);
		expect(queued.status).toBe(202);
		expect(replies.at(-1)?.text).toContain("กำลังตรวจสอบโค้ด");
		expect(jobs).toHaveLength(1);
		expect(jobs[0]).toMatchObject({
			interactionId: "1000004",
			delivery: "channel",
			sourceMessageId: "1000004",
			repository: "codemonday-dev/lms-backend",
			branch: "dev",
			question: "หา issue rate limit ให้หน่อย",
			idempotencyKey: "discord:message:1000004",
		});
		expect((await capabilityStore.getJob("1000004"))?.status).toBe("queued");
	});

	test("rejects unsigned requests before parsing and ignores unauthorized users", async () => {
		const deps = testDeps([], []);
		const unsigned = await handleDiscordGatewayMessage(
			new Request("https://agent.example/discord/gateway/messages", {
				method: "POST",
				body: "not-json",
			}),
			deps,
		);
		expect(unsigned.status).toBe(401);

		const unauthorized = await send(
			deps,
			gatewayMessage({ userId: "999999", botMentioned: true }),
		);
		expect(unauthorized.status).toBe(204);
	});

	test("uses a thread and carries the progress message id into the queued job", async () => {
		const jobs: DiscordJob[] = [];
		const replies: { channelId: string; text: string; messageId?: string }[] =
			[];
		const deps = testDeps(jobs, replies);
		deps.discordReplyClient.createThread = async () => "thread-123";
		deps.discordReplyClient.replyToChannel = async (
			channelId,
			text,
			messageId,
		) => {
			replies.push({ channelId, text, messageId });
			return text.includes("กำลังตรวจสอบ") ? "progress-123" : undefined;
		};

		await send(
			deps,
			gatewayMessage({
				messageId: "1000010",
				content: "<@900001> ตรวจ rate limit",
				botMentioned: true,
			}),
		);
		await send(
			deps,
			gatewayMessage({ messageId: "1000011", content: "lms-backend" }),
		);
		await send(deps, gatewayMessage({ messageId: "1000012", content: "dev" }));

		expect(jobs[0]).toMatchObject({
			channelId: "thread-123",
			sourceMessageId: undefined,
			progressMessageId: "progress-123",
			providerSessionId: "discord:channel:source-v1:600001:thread-123:700001",
		});
		expect(replies.at(-1)).toMatchObject({ channelId: "thread-123" });
	});
});

type Reply = { channelId: string; text: string; messageId?: string };

function route(intent: RoutedIntent): IntentRouterDecision {
	return {
		kind: "route",
		intent,
		probabilities: { code: 0, news: 0, general: 0, clarify: 0, [intent]: 1 },
	};
}

function routedDeps(
	intent: RoutedIntent,
	jobs: DiscordJob[],
	replies: Reply[],
): DiscordGatewayWebhookDeps {
	const deps = testDeps(jobs, replies);
	deps.config.intentRouter = {
		enabled: true,
		protocol: "systemone",
		endpointUrl: "https://llm.example/base/v1/systemone",
		cfAccessClientId: "client",
		cfAccessClientSecret: "secret",
		timeoutMs: 45000,
		minProbability: 0.75,
		minMargin: 0.2,
	};
	deps.classifyIntent = async () => route(intent);
	return deps;
}

function testDeps(
	jobs: DiscordJob[],
	replies: { channelId: string; text: string; messageId?: string }[],
): DiscordGatewayWebhookDeps {
	return {
		config: loadConfig({
			DISCORD_APPLICATION_ID: "800001",
			DISCORD_PUBLIC_KEY: "ab".repeat(32),
			DISCORD_BOT_TOKEN: "bot-token",
			DISCORD_GATEWAY_SHARED_SECRET: sharedSecret,
			DISCORD_ALLOWED_USER_IDS: "700001",
			DISCORD_ALLOWED_GUILD_IDS: "600001",
		}),
		discordJobQueue: { send: async (job) => void jobs.push(job) },
		discordUpdateStore: createPassThroughTelegramUpdateStore(),
		discordSourceSelectionStore: createMemoryTelegramSourceSelectionStore(),
		discordCodeSourceClient: {
			listRepositories: async () => [
				"codemonday-dev/lms-backend",
				"codemonday-dev/lms-web",
			],
			listBranches: async () => ["dev", "main"],
			branchExists: async (_repository, branch) => branch === "dev",
		},
		discordReplyClient: {
			reply: async () => undefined,
			replyToChannel: async (channelId, text, messageId) => {
				replies.push({ channelId, text, messageId });
			},
			sendTyping: async () => undefined,
		},
	};
}

function gatewayMessage(
	overrides: Partial<DiscordGatewayMessage> = {},
): DiscordGatewayMessage {
	return {
		type: "message_create",
		messageId: "1000001",
		channelId: "500001",
		guildId: "600001",
		userId: "700001",
		botUserId: "900001",
		content: "hello",
		botMentioned: false,
		...overrides,
	};
}

async function send(
	deps: DiscordGatewayWebhookDeps,
	message: DiscordGatewayMessage,
): Promise<Response> {
	const body = JSON.stringify(message);
	const timestamp = String(Math.floor(Date.now() / 1_000));
	return handleDiscordGatewayMessage(
		new Request("https://agent.example/discord/gateway/messages", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-discord-gateway-timestamp": timestamp,
				"x-discord-gateway-signature": createDiscordGatewaySignature(
					body,
					timestamp,
					sharedSecret,
				),
			},
			body,
		}),
		deps,
	);
}
