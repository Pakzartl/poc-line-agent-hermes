import { createHmac } from "node:crypto";
import { rm, stat, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { REST } from "@discordjs/rest";
import { WebSocketManager, WebSocketShardEvents } from "@discordjs/ws";
import {
	GatewayDispatchEvents,
	GatewayIntentBits,
	type GatewayMessageCreateDispatchData,
	type GatewayReadyDispatchData,
} from "discord-api-types/v10";

type Config = {
	botToken: string;
	workerGatewayUrl: string;
	sharedSecret: string;
	allowedUserIds: Set<string>;
	allowedGuildIds: Set<string>;
	readyFile: string;
	forwardTimeoutMs: number;
};

const config = loadConfig(process.env);

if (process.argv.includes("--healthcheck")) {
	if (await readyFileExists(config.readyFile)) {
		process.exit(0);
	}
	await delay(10);
	process.exit(1);
}

const rest = new REST().setToken(config.botToken);
let botUserId: string | undefined;
let shuttingDown = false;

const manager = new WebSocketManager({
	token: config.botToken,
	rest,
	intents:
		GatewayIntentBits.Guilds |
		GatewayIntentBits.GuildMessages |
		GatewayIntentBits.DirectMessages |
		GatewayIntentBits.MessageContent,
	shardCount: 1,
	shardIds: [0],
});

manager.on(WebSocketShardEvents.Ready, (ready: GatewayReadyDispatchData) => {
	botUserId = ready.user.id;
	void markReady(config.readyFile);
	logInfo("discord gateway ready", { botUserId });
});

manager.on(WebSocketShardEvents.Resumed, () => {
	void markReady(config.readyFile);
	logInfo("discord gateway resumed");
});

manager.on(WebSocketShardEvents.Closed, (code, shardId) => {
	void clearReady(config.readyFile);
	logWarn("discord gateway closed", { code, shardId });
});

manager.on(WebSocketShardEvents.Error, (error, shardId) => {
	void clearReady(config.readyFile);
	logError("discord gateway error", { error: error.message, shardId });
});

manager.on(WebSocketShardEvents.Dispatch, (payload) => {
	if (payload.t !== GatewayDispatchEvents.MessageCreate) {
		return;
	}
	void handleMessage(payload.d as GatewayMessageCreateDispatchData);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
	process.on(signal, () => {
		if (shuttingDown) {
			return;
		}
		shuttingDown = true;
		logInfo("discord gateway stopping", { signal });
		void clearReady(config.readyFile).finally(() => {
			void Promise.resolve(
				manager.destroy({ code: 1_000, reason: signal }),
			).finally(() => {
				process.exit(0);
			});
		});
	});
}

await manager.connect();

async function handleMessage(
	message: GatewayMessageCreateDispatchData,
): Promise<void> {
	if (!botUserId) {
		return;
	}
	if (message.author.bot || message.webhook_id) {
		return;
	}
	if (!config.allowedUserIds.has(message.author.id)) {
		return;
	}
	if (message.guild_id && !config.allowedGuildIds.has(message.guild_id)) {
		return;
	}

	const content = message.content.trim();
	if (!content) {
		return;
	}

	const botMentioned = message.mentions.some((user) => user.id === botUserId);
	const body = JSON.stringify({
		type: "message_create",
		messageId: message.id,
		channelId: message.channel_id,
		...(message.guild_id ? { guildId: message.guild_id } : {}),
		userId: message.author.id,
		botUserId,
		content,
		botMentioned,
	});

	try {
		await forwardToWorker(body);
		logInfo("discord message forwarded", {
			messageId: message.id,
			channelId: message.channel_id,
			guildId: message.guild_id,
			userId: message.author.id,
			botMentioned,
		});
	} catch (error) {
		logError("discord message forward failed", {
			messageId: message.id,
			channelId: message.channel_id,
			guildId: message.guild_id,
			userId: message.author.id,
			error: error instanceof Error ? error.message : "Unknown error",
		});
	}
}

async function forwardToWorker(body: string): Promise<void> {
	const timestamp = Math.floor(Date.now() / 1_000).toString();
	const signature = createHmac("sha256", config.sharedSecret)
		.update(`${timestamp}.${body}`)
		.digest("hex");
	const response = await fetchWithTimeout(
		config.workerGatewayUrl,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-discord-gateway-signature": signature,
				"x-discord-gateway-timestamp": timestamp,
			},
			body,
		},
		config.forwardTimeoutMs,
	);
	if (!response.ok) {
		throw new Error(`Worker gateway returned HTTP ${response.status}`);
	}
}

async function fetchWithTimeout(
	url: string,
	init: RequestInit,
	timeoutMs: number,
): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timeout);
	}
}

function loadConfig(env: NodeJS.ProcessEnv): Config {
	const required = [
		"DISCORD_BOT_TOKEN",
		"DISCORD_WORKER_GATEWAY_URL",
		"DISCORD_GATEWAY_SHARED_SECRET",
		"DISCORD_ALLOWED_USER_IDS",
		"DISCORD_ALLOWED_GUILD_IDS",
	] as const;
	const missing = required.filter((name) => !env[name]?.trim());
	if (missing.length > 0) {
		throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
	}

	const sharedSecret = env.DISCORD_GATEWAY_SHARED_SECRET?.trim() ?? "";
	if (sharedSecret.length < 32) {
		throw new Error("DISCORD_GATEWAY_SHARED_SECRET must contain at least 32 characters");
	}

	const workerGatewayUrl = env.DISCORD_WORKER_GATEWAY_URL?.trim() ?? "";
	try {
		const parsed = new URL(workerGatewayUrl);
		if (parsed.protocol !== "https:" && parsed.hostname !== "127.0.0.1") {
			throw new Error("DISCORD_WORKER_GATEWAY_URL must use https outside loopback");
		}
	} catch (error) {
		if (error instanceof Error) {
			throw new Error(`Invalid DISCORD_WORKER_GATEWAY_URL: ${error.message}`);
		}
		throw error;
	}

	const allowedUserIds = parseSnowflakeSet(env.DISCORD_ALLOWED_USER_IDS ?? "");
	const allowedGuildIds = parseSnowflakeSet(env.DISCORD_ALLOWED_GUILD_IDS ?? "");
	if (allowedUserIds.size === 0 || allowedGuildIds.size === 0) {
		throw new Error("Discord Gateway allowlists cannot be empty");
	}

	return {
		botToken: env.DISCORD_BOT_TOKEN?.trim() ?? "",
		workerGatewayUrl,
		sharedSecret,
		allowedUserIds,
		allowedGuildIds,
		readyFile: env.DISCORD_GATEWAY_READY_FILE?.trim() || "/tmp/discord-gateway-ready",
		forwardTimeoutMs: Number(env.DISCORD_GATEWAY_FORWARD_TIMEOUT_MS ?? "15000"),
	};
}

function parseSnowflakeSet(value: string): Set<string> {
	const ids = value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
	for (const id of ids) {
		if (!/^[1-9]\d{0,19}$/.test(id)) {
			throw new Error(`Invalid Discord snowflake in allowlist: ${id}`);
		}
	}
	return new Set(ids);
}

async function markReady(path: string): Promise<void> {
	await writeFile(path, new Date().toISOString(), { mode: 0o600 });
}

async function clearReady(path: string): Promise<void> {
	await rm(path, { force: true });
}

async function readyFileExists(path: string): Promise<boolean> {
	try {
		const stats = await stat(path);
		return stats.isFile();
	} catch {
		return false;
	}
}

function logInfo(message: string, fields: Record<string, unknown> = {}): void {
	console.log(JSON.stringify({ level: "info", message, ...fields }));
}

function logWarn(message: string, fields: Record<string, unknown> = {}): void {
	console.warn(JSON.stringify({ level: "warn", message, ...fields }));
}

function logError(message: string, fields: Record<string, unknown> = {}): void {
	console.error(JSON.stringify({ level: "error", message, ...fields }));
}
