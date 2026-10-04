import { describe, expect, test } from "bun:test";
import type { DiscordReplyClient } from "../discord/reply";
import { createKvTelegramUpdateStore } from "../telegram/update-store";
import { processQueueFailureDlqMessage } from "./queue-failure-dlq";

describe("queue failure DLQ consumer", () => {
	test("turns an exhausted Discord job into one redacted HIL artifact", async () => {
		const messages: unknown[][] = [];
		const values = new Map<string, string>();
		const deps = {
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
		const body = {
			provider: "discord",
			job: {
				interactionId: "interaction-1",
				interactionToken: "must-not-appear",
				action: "chat",
				capability: { kind: "risk_assessment" },
				text: "password=must-not-appear",
			},
		};

		await processQueueFailureDlqMessage({
			messageId: "message-1",
			body,
			attempts: 1,
			deps,
			now: new Date("2026-10-05T00:00:00.000Z"),
		});
		await processQueueFailureDlqMessage({
			messageId: "message-1",
			body,
			attempts: 2,
			deps,
			now: new Date("2026-10-05T00:00:01.000Z"),
		});

		expect(messages).toHaveLength(1);
		const options = messages[0]?.[3] as {
			attachment?: { data?: string };
		};
		expect(options.attachment?.data).toContain("discord:risk_assessment");
		expect(options.attachment?.data).toContain("interaction-1");
		expect(options.attachment?.data).not.toContain("must-not-appear");
	});
});
