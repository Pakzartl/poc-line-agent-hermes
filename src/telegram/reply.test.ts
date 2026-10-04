import { describe, expect, test } from "bun:test";
import { createTelegramReplyClient } from "./reply";

describe("Telegram reply client", () => {
	test("sends the typing chat action", async () => {
		const requests: { url: string; body: unknown }[] = [];
		const client = createTelegramReplyClient({
			botToken: "bot-token",
			apiBaseUrl: "https://telegram.example",
			fetch: async (input, init) => {
				requests.push({
					url: String(input),
					body: JSON.parse(String(init?.body)),
				});
				return new Response("{}", { status: 200 });
			},
		});

		await client.sendChatAction?.(9001);

		expect(requests).toEqual([
			{
				url: "https://telegram.example/botbot-token/sendChatAction",
				body: { chat_id: 9001, action: "typing" },
			},
		]);
	});
});
