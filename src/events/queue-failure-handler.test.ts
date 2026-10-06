import { describe, expect, test } from "bun:test";
import type { DiscordReplyClient } from "../discord/reply";
import type { TelegramCoordinatorRecord } from "../telegram/session-coordinator";
import type { TelegramUpdateStore } from "../telegram/update-store";
import { createKvTelegramUpdateStore } from "../telegram/update-store";
import { createQueueFailureArtifactResult } from "./queue-failure";
import {
	handleQueueFailureEvent,
	publishQueueFailureArtifact,
} from "./queue-failure-handler";

describe("queue failure HTTP handler", () => {
	test("publishes one visible Discord HIL artifact and deduplicates retries", async () => {
		const secret = "q".repeat(32);
		const body = JSON.stringify({
			version: "queue-failure/v1",
			eventId: "evt-1",
			queue: "email",
			jobName: "send-certificate",
			failedAt: "2026-10-04T00:00:00.000Z",
			attempts: 3,
			error: { message: "upstream timed out token=do-not-leak" },
			payload: {
				certificateId: "cert-1",
				apiToken: "payload-secret",
			},
			entity: {
				learnerId: "learner-1",
				email: "learner@example.com",
			},
		});
		const timestamp = String(Math.floor(Date.now() / 1_000));
		const signature = await sign(body, timestamp, secret);
		const messages: unknown[][] = [];
		const values = new Map<string, string>();
		const deps = {
			secret,
			discordChannelId: "channel-1",
			discordReplyClient: {
				reply: async () => undefined,
				replyToChannel: async (...args: unknown[]) => {
					messages.push(args);
				},
				sendTyping: async () => undefined,
			} satisfies DiscordReplyClient,
			updateStore: createKvTelegramUpdateStore({
				get: async (key) => values.get(key) ?? null,
				put: async (key, value) => {
					values.set(key, value);
				},
				delete: async (key) => {
					values.delete(key);
				},
			}),
		};
		const request = () =>
			new Request("https://agent.example/events/queue-failure", {
				method: "POST",
				headers: {
					"X-Javis-Timestamp": timestamp,
					"X-Javis-Signature": `sha256=${signature}`,
				},
				body,
			});
		const first = await handleQueueFailureEvent(request(), deps);
		const second = await handleQueueFailureEvent(request(), deps);

		expect(first.status).toBe(202);
		expect(second.status).toBe(202);
		expect((await second.json()) as unknown).toMatchObject({ duplicate: true });
		expect(messages).toHaveLength(1);
		const options = messages[0]?.[3] as {
			attachment?: { data?: string; filename?: string };
		};
		expect(options.attachment?.filename).toEndWith(".md");
		expect(options.attachment?.data).not.toContain("do-not-leak");
		expect(options.attachment?.data).not.toContain("payload-secret");
		expect(options.attachment?.data).not.toContain("learner@example.com");
		expect(options.attachment?.data).toContain("Payload");
		expect(options.attachment?.data).toContain("Related entity");
	});

	test("rejects unsigned events before delivery", async () => {
		const response = await handleQueueFailureEvent(
			new Request("https://agent.example/events/queue-failure", {
				method: "POST",
				body: "{}",
			}),
			{
				secret: "q".repeat(32),
				discordChannelId: "channel-1",
				discordReplyClient: {
					reply: async () => undefined,
					replyToChannel: async () => undefined,
					sendTyping: async () => undefined,
				},
				updateStore: createKvTelegramUpdateStore({
					get: async () => null,
					put: async () => undefined,
					delete: async () => undefined,
				}),
			},
		);
		expect(response.status).toBe(401);
	});

	test("rejects stale and tampered signed events", async () => {
		const secret = "q".repeat(32);
		const body = JSON.stringify({
			version: "queue-failure/v1",
			eventId: "evt-2",
			queue: "email",
			jobName: "send-certificate",
			failedAt: new Date().toISOString(),
			attempts: 3,
			maxAttempts: 3,
			error: { message: "timeout" },
		});
		const staleTimestamp = String(Math.floor(Date.now() / 1_000) - 600);
		const deps = {
			secret,
			discordChannelId: "",
			discordReplyClient: {
				reply: async () => undefined,
				replyToChannel: async () => undefined,
				sendTyping: async () => undefined,
			},
			updateStore: createKvTelegramUpdateStore({
				get: async () => null,
				put: async () => undefined,
				delete: async () => undefined,
			}),
		};
		const stale = await handleQueueFailureEvent(
			new Request("https://agent.example/events/queue-failure", {
				method: "POST",
				headers: {
					"X-Javis-Timestamp": staleTimestamp,
					"X-Javis-Signature": `sha256=${await sign(body, staleTimestamp, secret)}`,
				},
				body,
			}),
			deps,
		);
		expect(stale.status).toBe(401);

		const currentTimestamp = String(Math.floor(Date.now() / 1_000));
		const tampered = await handleQueueFailureEvent(
			new Request("https://agent.example/events/queue-failure", {
				method: "POST",
				headers: {
					"X-Javis-Timestamp": currentTimestamp,
					"X-Javis-Signature": `sha256=${await sign(body, currentTimestamp, secret)}`,
				},
				body: body.replace("timeout", "forbidden"),
			}),
			deps,
		);
		expect(tampered.status).toBe(401);
	});

	test("resumes a checkpointed Discord delivery without duplicating a completed artifact", async () => {
		let record: TelegramCoordinatorRecord | undefined;
		let deliveryAttempts = 0;
		const store: TelegramUpdateStore = {
			claim: async (input) => {
				if (record) return { claimed: false, duplicate: true, record };
				record = coordinatorRecord(
					input.idempotencyKey,
					input.providerSessionId,
				);
				return { claimed: true, duplicate: false, record };
			},
			dispatchLease: async () => {
				record = { ...record!, status: "dispatched" };
				return { kind: "leased", record };
			},
			beginReply: async (input) => {
				record = {
					...record!,
					status: "replying",
					replyContent: input.replyContent,
					replyContentHash: input.replyContentHash,
				};
				return { kind: "ready", record };
			},
			complete: async () => {
				record = { ...record!, status: "completed" };
			},
			fail: async () => undefined,
			markUncertain: async () => undefined,
			release: async () => undefined,
			retryPreReply: async () => undefined,
		};
		const result = await createQueueFailureArtifactResult({
			version: "queue-failure/v1",
			eventId: "evt-retry",
			queue: "jobs",
			jobName: "sync",
			failedAt: "2026-10-04T00:00:00.000Z",
			attempts: 3,
			error: { message: "timeout" },
		});
		const deps = {
			discordChannelId: "channel-1",
			discordReplyClient: {
				reply: async () => undefined,
				replyToChannel: async () => {
					deliveryAttempts += 1;
					if (deliveryAttempts === 1) throw new Error("Discord unavailable");
				},
				sendTyping: async () => undefined,
			} satisfies DiscordReplyClient,
			updateStore: store,
		};

		await expect(publishQueueFailureArtifact(result, deps)).rejects.toThrow(
			"Discord unavailable",
		);
		expect(record?.status).toBe("replying");
		expect((await publishQueueFailureArtifact(result, deps)).duplicate).toBe(
			false,
		);
		expect(record?.status).toBe("completed");
		expect((await publishQueueFailureArtifact(result, deps)).duplicate).toBe(
			true,
		);
		expect(deliveryAttempts).toBe(2);
	});
});

function coordinatorRecord(
	key: string,
	providerSessionId: string,
): TelegramCoordinatorRecord {
	return {
		version: 1,
		status: "claimed",
		key,
		sessionSequence: 1,
		generation: "generation-1",
		providerSessionId,
		canonicalInputHash: key,
		attemptCount: 0,
		expiresAt: "2026-10-05T00:00:00.000Z",
	};
}

async function sign(
	body: string,
	timestamp: string,
	secret: string,
): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const digest = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(`${timestamp}.${body}`),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}
