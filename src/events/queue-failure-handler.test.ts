import { describe, expect, test } from "bun:test";
import type { DiscordReplyClient } from "../discord/reply";
import { createKvTelegramUpdateStore } from "../telegram/update-store";
import { handleQueueFailureEvent } from "./queue-failure-handler";

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
		const signature = await sign(body, secret);
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
				headers: { "X-Javis-Signature": `sha256=${signature}` },
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
});

async function sign(body: string, secret: string): Promise<string> {
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
		new TextEncoder().encode(body),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}
