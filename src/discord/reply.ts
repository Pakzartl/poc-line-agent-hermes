import { formatDiscordMarkdown } from "./format";

const discordMessageLimit = 2_000;
const maxInteractionMessages = 6;
const truncationMarker = "\n\n[response truncated]";

type FetchLike = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

export type DiscordReplyClient = {
	reply(
		applicationId: string,
		interactionToken: string,
		text: string,
		options?: DiscordReplyOptions,
	): Promise<void>;
	replyToChannel(
		channelId: string,
		text: string,
		replyToMessageId?: string,
		options?: DiscordReplyOptions,
	): Promise<string | undefined>;
	sendTyping(channelId: string): Promise<void>;
	createThread?(
		channelId: string,
		messageId: string,
		name: string,
	): Promise<string | undefined>;
	editChannelMessage?(
		channelId: string,
		messageId: string,
		text: string,
		options?: DiscordReplyOptions,
	): Promise<void>;
	updateInteractionProgress?(
		applicationId: string,
		interactionToken: string,
		text: string,
	): Promise<void>;
};

export type DiscordReplyAttachment = {
	filename: string;
	contentType: string;
	data: string | Uint8Array;
};

export type DiscordReplyOptions = {
	attachment?: DiscordReplyAttachment;
	attachments?: readonly DiscordReplyAttachment[];
	components?: readonly Record<string, unknown>[];
};

export class DiscordApiError extends Error {
	readonly status: number;
	readonly retryable: boolean;

	constructor(status: number, message: string) {
		super(message);
		this.name = "DiscordApiError";
		this.status = status;
		this.retryable = status === 429 || status >= 500;
	}
}

export function createDiscordReplyClient(config: {
	apiBaseUrl?: string;
	fetch?: FetchLike;
	botToken?: string;
}): DiscordReplyClient {
	const fetchImpl = config.fetch ?? fetch;
	const apiBaseUrl = (
		config.apiBaseUrl ?? "https://discord.com/api/v10"
	).replace(/\/+$/, "");

	return {
		async reply(applicationId, interactionToken, text, replyOptions) {
			const chunks = splitDiscordMessage(text);
			await sendInteraction(
				`${apiBaseUrl}/webhooks/${encodeURIComponent(applicationId)}/${encodeURIComponent(interactionToken)}/messages/@original`,
				"PATCH",
				chunks[0] ?? "Done",
				replyOptions,
			);
			for (const chunk of chunks.slice(1)) {
				await sendInteraction(
					`${apiBaseUrl}/webhooks/${encodeURIComponent(applicationId)}/${encodeURIComponent(interactionToken)}`,
					"POST",
					chunk,
				);
			}
		},
		async replyToChannel(channelId, text, replyToMessageId, replyOptions) {
			const chunks = splitDiscordMessage(text);
			let firstMessageId: string | undefined;
			for (const [index, chunk] of chunks.entries()) {
				const response = await sendBotRequest(
					`${apiBaseUrl}/channels/${encodeURIComponent(channelId)}/messages`,
					{
						content: chunk,
						allowed_mentions: { parse: [], replied_user: false },
						...(index === 0 && replyToMessageId
							? {
									message_reference: {
										message_id: replyToMessageId,
										fail_if_not_exists: false,
									},
								}
							: {}),
					},
					index === 0 ? replyOptions : undefined,
				);
				if (index === 0) firstMessageId = await responseMessageId(response);
			}
			return firstMessageId;
		},
		async sendTyping(channelId) {
			await sendBotRequest(
				`${apiBaseUrl}/channels/${encodeURIComponent(channelId)}/typing`,
			);
		},
		async updateInteractionProgress(applicationId, interactionToken, text) {
			await sendInteraction(
				`${apiBaseUrl}/webhooks/${encodeURIComponent(applicationId)}/${encodeURIComponent(interactionToken)}/messages/@original`,
				"PATCH",
				text,
			);
		},
		async createThread(channelId, messageId, name) {
			const response = await sendBotRequest(
				`${apiBaseUrl}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/threads`,
				{
					name: name.trim().slice(0, 100) || "Javis investigation",
					auto_archive_duration: 60,
				},
			);
			return responseMessageId(response);
		},
		async editChannelMessage(channelId, messageId, text, replyOptions) {
			const chunks = splitDiscordMessage(text);
			await sendBotRequest(
				`${apiBaseUrl}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,
				{
					content: chunks[0] ?? "Done",
					allowed_mentions: { parse: [] },
				},
				replyOptions,
				"PATCH",
			);
			for (const chunk of chunks.slice(1)) {
				await sendBotRequest(
					`${apiBaseUrl}/channels/${encodeURIComponent(channelId)}/messages`,
					{ content: chunk, allowed_mentions: { parse: [] } },
				);
			}
		},
	};

	async function sendInteraction(
		url: string,
		method: "PATCH" | "POST",
		content: string,
		options?: DiscordReplyOptions,
	): Promise<void> {
		const response = await fetchImpl(url, {
			method,
			...requestPayload(
				{
					content,
					allowed_mentions: { parse: [] },
					...(options?.components ? { components: options.components } : {}),
					...(method === "POST" ? { flags: 1 << 6 } : {}),
				},
				options,
			),
		});
		if (!response.ok) {
			throw new DiscordApiError(
				response.status,
				`Discord reply failed with status ${response.status}`,
			);
		}
	}

	function requestPayload(
		payload: Record<string, unknown>,
		options?: DiscordReplyOptions,
	): Pick<RequestInit, "headers" | "body"> {
		const attachments = options?.attachments?.length
			? [...options.attachments]
			: options?.attachment
				? [options.attachment]
				: [];
		if (attachments.length === 0) {
			return {
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			};
		}
		const form = new FormData();
		form.append(
			"payload_json",
			JSON.stringify(
				attachments.length > 1
					? {
							...payload,
							attachments: attachments.map((attachment, id) => ({
								id,
								filename: attachment.filename,
							})),
						}
					: payload,
			),
		);
		for (const [index, attachment] of attachments.entries()) {
			form.append(
				`files[${index}]`,
				new Blob([attachmentBlobPart(attachment.data)], {
					type: attachment.contentType,
				}),
				attachment.filename,
			);
		}
		return { body: form };
	}

	function attachmentBlobPart(data: string | Uint8Array): string | ArrayBuffer {
		if (typeof data === "string") {
			return data;
		}
		const buffer = new ArrayBuffer(data.byteLength);
		new Uint8Array(buffer).set(data);
		return buffer;
	}

	async function sendBotRequest(
		url: string,
		body?: Record<string, unknown>,
		options?: DiscordReplyOptions,
		method: "POST" | "PATCH" = "POST",
	): Promise<Response> {
		if (!config.botToken?.trim()) {
			throw new Error("DISCORD_BOT_TOKEN is required for channel replies");
		}
		const messageBody =
			body && options?.components
				? { ...body, components: options.components }
				: body;
		const payload = messageBody ? requestPayload(messageBody, options) : {};
		const response = await fetchImpl(url, {
			method,
			headers: {
				Authorization: `Bot ${config.botToken}`,
				...(payload.headers ?? {}),
			},
			...(payload.body ? { body: payload.body } : {}),
		});
		if (!response.ok) {
			throw new DiscordApiError(
				response.status,
				`Discord bot request failed with status ${response.status}`,
			);
		}
		return response;
	}
}

async function responseMessageId(
	response: Response,
): Promise<string | undefined> {
	if (response.status === 204) return undefined;
	try {
		const body = (await response.json()) as { id?: unknown };
		return typeof body.id === "string" && body.id ? body.id : undefined;
	} catch {
		return undefined;
	}
}

export function splitDiscordMessage(text: string): string[] {
	const value = formatDiscordMarkdown(text) || "Done";
	const chunks: string[] = [];
	let remaining = value;
	while (
		remaining.length > discordMessageLimit &&
		chunks.length < maxInteractionMessages - 1
	) {
		let boundary = findSplitBoundary(remaining, discordMessageLimit);
		let chunk = remaining.slice(0, boundary).trimEnd();
		let openFence = findOpenCodeFence(chunk);
		if (openFence) {
			boundary = findSplitBoundary(remaining, discordMessageLimit - 4);
			chunk = remaining.slice(0, boundary).trimEnd();
			openFence = findOpenCodeFence(chunk);
		}
		chunks.push(openFence ? `${chunk}\n\`\`\`` : chunk);
		remaining = `${openFence ? `${openFence}\n` : ""}${remaining
			.slice(boundary)
			.trimStart()}`;
	}
	if (remaining.length > discordMessageLimit) {
		chunks.push(truncateDiscordMessage(remaining));
	} else {
		chunks.push(remaining);
	}
	return chunks;
}

function truncateDiscordMessage(text: string): string {
	let content = text
		.slice(0, discordMessageLimit - truncationMarker.length)
		.trimEnd();
	if (findOpenCodeFence(content)) {
		content = text
			.slice(0, discordMessageLimit - truncationMarker.length - 4)
			.trimEnd();
		return `${content}\n\`\`\`${truncationMarker}`;
	}
	return `${content}${truncationMarker}`;
}

function findOpenCodeFence(text: string): string | undefined {
	let opening: string | undefined;
	for (const line of text.split("\n")) {
		const match = line.match(/^\s*(```[^`]*)$/);
		if (!match) {
			continue;
		}
		opening = opening ? undefined : match[1];
	}
	return opening;
}

function findSplitBoundary(text: string, limit: number): number {
	const window = text.slice(0, limit + 1);
	const paragraph = window.lastIndexOf("\n\n");
	if (paragraph >= Math.floor(limit * 0.6)) {
		return paragraph;
	}
	const newline = window.lastIndexOf("\n");
	if (newline >= Math.floor(limit * 0.6)) {
		return newline;
	}
	const space = window.lastIndexOf(" ");
	return space >= Math.floor(limit * 0.6) ? space : limit;
}
