import { describe, expect, test } from "bun:test";
import { type AppDeps, createAppHandler } from "./app";
import { loadConfig } from "./config";

describe("app routes", () => {
	test("serves a secure status page at the custom-domain root", async () => {
		const response = await createAppHandler(testDeps())(
			new Request("https://agent.pakzartl.xyz/"),
		);
		const body = await response.text();

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/html");
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("content-security-policy")).toContain(
			"default-src 'none'",
		);
		expect(body).toContain("Messaging Agent");
		expect(body).toContain("/health");
	});

	test("keeps unknown routes closed", async () => {
		const response = await createAppHandler(testDeps())(
			new Request("https://agent.pakzartl.xyz/private"),
		);

		expect(response.status).toBe(404);
	});

	test("ingests signed queue failure events and posts a HIL artifact when configured", async () => {
		const channelReplies: unknown[][] = [];
		const secret = "queue-event-secret";
		const body = JSON.stringify({
			version: "queue-failure/v1",
			eventId: "job-123",
			queue: "email-jobs",
			jobName: "send-welcome-email",
			failedAt: "2026-10-04T10:00:00.000Z",
			attempts: 3,
			maxAttempts: 3,
			error: { message: "upstream 503 from email provider" },
			logs: ["provider returned 503"],
		});
		const deps = testDeps({
			config: loadConfig({
				QUEUE_FAILURE_EVENT_SECRET: secret,
				QUEUE_FAILURE_DISCORD_CHANNEL_ID: "123456789012345678",
			}),
			discordReplyClient: {
				reply: async () => undefined,
				replyToChannel: async (...args) => {
					channelReplies.push(args);
				},
				sendTyping: async () => undefined,
			},
		});

		const response = await createAppHandler(deps)(
			new Request("https://agent.pakzartl.xyz/events/queue-failure", {
				method: "POST",
				headers: {
					"x-javis-signature": `sha256=${await hmacHex(body, secret)}`,
				},
				body,
			}),
		);
		const result = (await response.json()) as {
			accepted: boolean;
			postedToDiscord: boolean;
			artifact: { capability: string; title: string };
		};

		expect(response.status).toBe(202);
		expect(result).toMatchObject({
			accepted: true,
			postedToDiscord: true,
			artifact: {
				capability: "queue-failure",
				title: "Queue failure: send-welcome-email",
			},
		});
		expect(channelReplies).toHaveLength(1);
		expect(channelReplies[0]?.[0]).toBe("123456789012345678");
		expect(channelReplies[0]?.[1]).toContain("Queue failure:");
		expect(
			(channelReplies[0]?.[3] as { attachment?: { data: string } }).attachment
				?.data,
		).toContain("Likely dependency queue failure");
	});
});

function testDeps(overrides: Partial<AppDeps> = {}): AppDeps {
	return {
		config: loadConfig({}),
		orchestrator: { answer: async () => "unused" },
		lineReplyClient: { reply: async () => undefined },
		telegramReplyClient: { reply: async () => undefined },
		discordReplyClient: {
			reply: async () => undefined,
			replyToChannel: async () => undefined,
			sendTyping: async () => undefined,
		},
		telegramJobQueue: { send: async () => undefined },
		discordJobQueue: { send: async () => undefined },
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
		discordUpdateStore: {
			claim: async () => ({ claimed: true, duplicate: false }),
			dispatchLease: async () => ({ kind: "leased", record: record() }),
			complete: async () => undefined,
			fail: async () => undefined,
			markUncertain: async () => undefined,
			release: async () => undefined,
			retryPreReply: async () => undefined,
			beginReply: async () => ({ kind: "ready", record: record() }),
		},
		whatsAppReplyClient: { reply: async () => undefined },
		memoryStore: {
			read: async () => [],
			append: async (_sessionId, messages) => messages,
			clear: async () => undefined,
		},
		...overrides,
	};
}

function record() {
	return {
		version: 1 as const,
		status: "claimed" as const,
		key: "telegram:update:test",
		sessionSequence: 1,
		generation: "gen",
		providerSessionId: "telegram:chat:test",
		canonicalInputHash: "hash",
		attemptCount: 0,
		expiresAt: new Date(Date.now() + 1_000).toISOString(),
	};
}

async function hmacHex(body: string, secret: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(body),
	);
	return [...new Uint8Array(signature)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}
