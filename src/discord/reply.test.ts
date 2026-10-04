import { describe, expect, test } from "bun:test";
import { formatDiscordMarkdown } from "./format";
import { createDiscordReplyClient, splitDiscordMessage } from "./reply";

describe("Discord reply client", () => {
	test("edits the deferred response and sends overflow as followups", async () => {
		const requests: { url: string; method: string; content: string }[] = [];
		const client = createDiscordReplyClient({
			apiBaseUrl: "https://discord.example/api/v10",
			fetch: async (input, init) => {
				const body = JSON.parse(String(init?.body)) as { content: string };
				requests.push({
					url: String(input),
					method: init?.method ?? "GET",
					content: body.content,
				});
				return new Response(null, { status: 204 });
			},
		});

		await client.reply("app", "token", "a".repeat(2_100));

		expect(requests).toHaveLength(2);
		expect(requests[0]?.method).toBe("PATCH");
		expect(requests[0]?.url).toEndWith(
			"/webhooks/app/token/messages/@original",
		);
		expect(requests[1]?.method).toBe("POST");
		expect(requests.every((request) => request.content.length <= 2_000)).toBe(
			true,
		);
	});

	test("caps output to the original plus five followups", () => {
		const chunks = splitDiscordMessage("x".repeat(20_000));

		expect(chunks).toHaveLength(6);
		expect(chunks.at(-1)).toEndWith("[response truncated]");
	});

	test("closes a code fence when a long response is truncated", () => {
		const chunks = splitDiscordMessage(
			`\`\`\`ts\n${"const value = 1;\n".repeat(2_000)}\`\`\``,
		);
		const lastChunk = chunks.at(-1) ?? "";

		expect(chunks).toHaveLength(6);
		expect(lastChunk).toEndWith("```\n\n[response truncated]");
		expect(
			lastChunk.split("\n").filter((line) => line.startsWith("```")).length % 2,
		).toBe(0);
	});

	test("converts markdown tables into Discord-readable sections", () => {
		const formatted = formatDiscordMarkdown(`สรุปผล:

| จุดที่จำกัด | ค่า | หมายเหตุ |
|---|---:|---|
| Learner Gateway | 100 requests / 60 วินาที | ใช้ทุก route |
| videoStampBurst | \`100 / 5s\` | named limit |`);

		expect(formatted).toBe(`สรุปผล:

**Learner Gateway**
- **ค่า:** 100 requests / 60 วินาที
- **หมายเหตุ:** ใช้ทุก route

**videoStampBurst**
- **ค่า:** \`100 / 5s\`
- **หมายเหตุ:** named limit`);
		expect(formatted).not.toContain("|---|---:|---|");
	});

	test("does not transform table-like content inside code fences", () => {
		const markdown = "```md\n| name | value |\n|---|---|\n| a | b |\n```";

		expect(formatDiscordMarkdown(markdown)).toBe(markdown);
	});

	test("keeps long code blocks renderable across message chunks", () => {
		const chunks = splitDiscordMessage(
			`ก่อนหน้า\n\n\`\`\`ts\n${"const value = 1;\n".repeat(
				180,
			)}\`\`\`\n\nหลังจากนั้น`,
		);

		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.every((chunk) => chunk.length <= 2_000)).toBe(true);
		expect(
			chunks.every(
				(chunk) =>
					chunk.split("\n").filter((line) => line.startsWith("```")).length %
						2 ===
					0,
			),
		).toBe(true);
		expect(chunks.at(-1)).toContain("หลังจากนั้น");
	});

	test("sends channel replies and typing with bot authentication", async () => {
		const requests: { url: string; init?: RequestInit }[] = [];
		const client = createDiscordReplyClient({
			apiBaseUrl: "https://discord.example/api/v10",
			botToken: "bot-token",
			fetch: async (input, init) => {
				requests.push({ url: String(input), init });
				return new Response(null, { status: 204 });
			},
		});

		await client.sendTyping("channel");
		await client.replyToChannel("channel", "answer", "message");

		expect(requests).toHaveLength(2);
		expect(requests[0]?.url).toEndWith("/channels/channel/typing");
		expect(requests[0]?.init?.headers).toEqual({
			Authorization: "Bot bot-token",
		});
		expect(requests[1]?.url).toEndWith("/channels/channel/messages");
		const replyBody = JSON.parse(String(requests[1]?.init?.body));
		expect(replyBody).toEqual({
			content: "answer",
			allowed_mentions: { parse: [], replied_user: false },
			message_reference: {
				message_id: "message",
				fail_if_not_exists: false,
			},
		});
	});

	test("sends one attachment on the final interaction chunk using multipart", async () => {
		const requests: { init?: RequestInit }[] = [];
		const client = createDiscordReplyClient({
			apiBaseUrl: "https://discord.example/api/v10",
			fetch: async (_input, init) => {
				requests.push({ init });
				return new Response(null, { status: 204 });
			},
		});

		await client.reply("app", "token", "a".repeat(2_100), {
			attachment: {
				filename: "risk-assessment.md",
				contentType: "text/markdown;charset=utf-8",
				data: "# Risk\n",
			},
		});

		expect(requests).toHaveLength(2);
		expect(requests[0]?.init?.headers).toEqual({
			"Content-Type": "application/json",
		});
		expect(requests[1]?.init?.headers).toBeUndefined();
		expect(requests[1]?.init?.body).toBeInstanceOf(FormData);
		const finalForm = requests[1]?.init?.body as FormData;
		expect(JSON.parse(String(finalForm.get("payload_json")))).toEqual({
			content: "a".repeat(100),
			allowed_mentions: { parse: [] },
			flags: 1 << 6,
		});
		const file = finalForm.get("files[0]") as File;
		expect(file.name).toBe("risk-assessment.md");
		expect(file.type).toBe("text/markdown;charset=utf-8");
		expect(await file.text()).toBe("# Risk\n");
	});

	test("sends one attachment on the final channel reply only", async () => {
		const requests: { init?: RequestInit }[] = [];
		const client = createDiscordReplyClient({
			apiBaseUrl: "https://discord.example/api/v10",
			botToken: "bot-token",
			fetch: async (_input, init) => {
				requests.push({ init });
				return new Response(null, { status: 204 });
			},
		});

		await client.replyToChannel("channel", "a".repeat(2_100), "message", {
			attachment: {
				filename: "artifact.json",
				contentType: "application/json",
				data: new TextEncoder().encode('{"ok":true}\n'),
			},
		});

		expect(requests).toHaveLength(2);
		expect(requests[0]?.init?.headers).toEqual({
			Authorization: "Bot bot-token",
			"Content-Type": "application/json",
		});
		const firstPayload = JSON.parse(String(requests[0]?.init?.body));
		expect(firstPayload.message_reference).toEqual({
			message_id: "message",
			fail_if_not_exists: false,
		});
		expect(requests[1]?.init?.headers).toEqual({
			Authorization: "Bot bot-token",
		});
		expect(requests[1]?.init?.body).toBeInstanceOf(FormData);
		const finalForm = requests[1]?.init?.body as FormData;
		const payload = JSON.parse(String(finalForm.get("payload_json")));
		expect(payload.message_reference).toBeUndefined();
		expect(await (finalForm.get("files[0]") as File).text()).toBe(
			'{"ok":true}\n',
		);
	});

	test("includes approval components on the original interaction reply", async () => {
		let payload: Record<string, unknown> | undefined;
		const client = createDiscordReplyClient({
			apiBaseUrl: "https://discord.example/api/v10",
			fetch: async (_input, init) => {
				payload = JSON.parse(String(init?.body));
				return new Response(null, { status: 204 });
			},
		});
		const components = [
			{
				type: 1,
				components: [
					{
						type: 2,
						style: 3,
						label: "Approve deploy",
						custom_id: "cap:approve:approval_1",
					},
				],
			},
		];

		await client.reply("app", "token", "Plan ready", { components });

		expect(payload).toEqual({
			content: "Plan ready",
			allowed_mentions: { parse: [] },
			components,
		});
	});

	test("creates an investigation thread and edits a progress message in place", async () => {
		const requests: { url: string; method?: string; body?: unknown }[] = [];
		const client = createDiscordReplyClient({
			apiBaseUrl: "https://discord.example/api/v10",
			botToken: "bot-token",
			fetch: async (input, init) => {
				requests.push({
					url: String(input),
					method: init?.method,
					body: init?.body,
				});
				if (String(input).endsWith("/threads")) {
					return Response.json({ id: "thread-1" });
				}
				return Response.json({ id: "progress-1" });
			},
		});

		expect(
			await client.createThread?.("channel", "message", "Javis test"),
		).toBe("thread-1");
		await client.editChannelMessage?.("thread-1", "progress-1", "completed");

		expect(requests[0]?.url).toEndWith(
			"/channels/channel/messages/message/threads",
		);
		expect(requests[1]).toMatchObject({
			url: "https://discord.example/api/v10/channels/thread-1/messages/progress-1",
			method: "PATCH",
		});
	});

	test("uploads a data artifact and Markdown HIL artifact together", async () => {
		let body: FormData | undefined;
		const client = createDiscordReplyClient({
			apiBaseUrl: "https://discord.example/api/v10",
			fetch: async (_input, init) => {
				body = init?.body as FormData;
				return new Response(null, { status: 204 });
			},
		});
		await client.reply("app", "token", "done", {
			attachments: [
				{
					filename: "result.json",
					contentType: "application/json",
					data: "{}",
				},
				{
					filename: "hil.md",
					contentType: "text/markdown",
					data: "# HIL",
				},
			],
		});

		const payload = JSON.parse(String(body?.get("payload_json")));
		expect(payload.attachments).toEqual([
			{ id: 0, filename: "result.json" },
			{ id: 1, filename: "hil.md" },
		]);
		expect(await (body?.get("files[0]") as File).text()).toBe("{}");
		expect(await (body?.get("files[1]") as File).text()).toBe("# HIL");
	});
});
