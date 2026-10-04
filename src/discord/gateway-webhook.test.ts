import { describe, expect, test } from "bun:test";
import { loadConfig } from "../config";
import { createMemoryTelegramSourceSelectionStore } from "../telegram/source-selection";
import { createPassThroughTelegramUpdateStore } from "../telegram/update-store";
import type { DiscordJob } from "./job";
import { createDiscordGatewaySignature } from "./gateway-signature";
import {
	handleDiscordGatewayMessage,
	type DiscordGatewayMessage,
	type DiscordGatewayWebhookDeps,
} from "./gateway-webhook";

const sharedSecret = "gateway-secret-which-is-long-enough";

describe("Discord Gateway webhook", () => {
	test("keeps ordinary chat quiet and completes mention to repo to branch flow", async () => {
		const jobs: DiscordJob[] = [];
		const replies: { channelId: string; text: string; messageId?: string }[] =
			[];
		const deps = testDeps(jobs, replies);

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
});

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
