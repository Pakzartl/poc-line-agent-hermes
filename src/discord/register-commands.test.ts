import { describe, expect, test } from "bun:test";
import { discordCommands, registerDiscordCommands } from "./register-commands";

const expectedCommands = [
	"code",
	"risk",
	"db",
	"artifact",
	"deploy",
	"status",
	"cancel",
	"skills",
	"clear",
] as const;

describe("Discord command registration", () => {
	test("registers only the Discord operating-interface surface", () => {
		expect(discordCommands.map((command) => command.name)).toEqual([
			...expectedCommands,
		]);
		expect(
			discordCommands.map((command) => String(command.name)),
		).not.toContain("ask");
	});

	test("replaces guild commands with the exact command inventory", async () => {
		let request: Request | undefined;
		await registerDiscordCommands({
			applicationId: "app",
			guildId: "guild",
			botToken: "secret",
			fetch: (async (input, init) => {
				request = new Request(input, init);
				return Response.json([]);
			}) as typeof fetch,
		});
		expect(request?.method).toBe("PUT");
		expect(request?.url).toBe(
			"https://discord.com/api/v10/applications/app/guilds/guild/commands",
		);
		const body = (await request?.json()) as Array<{ name: string }>;
		expect(body.map((command) => command.name)).toEqual([...expectedCommands]);
	});
});
