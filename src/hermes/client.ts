export type HermesClient = {
	chat(input: HermesChatInput): Promise<HermesChatResult>;
	listMessages(sessionId: string): Promise<HermesSessionMessage[]>;
	lastMessageMarker(
		sessionId: string,
	): Promise<HermesMessageMarker | undefined>;
	clearSession(sessionId: string): Promise<void>;
};

export type HermesChatInput = {
	sessionId: string;
	source: string;
	input: string;
};

export type HermesChatResult = {
	text: string;
};

export type HermesMessageMarker = {
	id?: string;
	timestamp?: string;
};

export type HermesSessionMessage = {
	id?: string;
	timestamp?: string;
	role: "user" | "assistant" | string;
	content: string;
};

export type HermesClientOptions = {
	baseUrl: string;
	apiServerKey: string;
	fetch?: typeof fetch;
};

export class HermesApiError extends Error {
	readonly status?: number;
	readonly retryable: boolean;
	readonly ambiguous: boolean;

	constructor(input: {
		message: string;
		status?: number;
		retryable: boolean;
		ambiguous?: boolean;
	}) {
		super(input.message);
		this.name = "HermesApiError";
		this.status = input.status;
		this.retryable = input.retryable;
		this.ambiguous = input.ambiguous ?? false;
	}
}

export function createHermesClient(options: HermesClientOptions): HermesClient {
	const fetchImpl = options.fetch ?? fetch;
	const baseUrl = options.baseUrl.replace(/\/+$/, "");
	const authHeaders = {
		Authorization: `Bearer ${options.apiServerKey}`,
	};

	return {
		async chat(input) {
			await fetchHermes(
				fetchImpl,
				sessionsUrl(baseUrl),
				{
					method: "POST",
					headers: {
						...authHeaders,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						id: input.sessionId,
						source: input.source,
					}),
				},
				[409],
			);
			const response = await fetchHermes(
				fetchImpl,
				chatUrl(baseUrl, input.sessionId),
				{
					method: "POST",
					headers: {
						...authHeaders,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ input: input.input }),
				},
			);
			const body = await response.json().catch(() => undefined);
			const text = extractAssistantText(body);
			if (!text.trim()) {
				throw new HermesApiError({
					message: "Hermes chat response did not contain assistant text",
					status: response.status,
					retryable: true,
					ambiguous: true,
				});
			}
			return { text };
		},
		async listMessages(sessionId) {
			const response = await fetchHermes(
				fetchImpl,
				messagesUrl(baseUrl, sessionId),
				{
					method: "GET",
					headers: authHeaders,
				},
				[404],
			);
			if (response.status === 404) {
				return [];
			}
			const body = await response.json().catch(() => undefined);
			return extractMessages(body);
		},
		async lastMessageMarker(sessionId) {
			const messages = await this.listMessages(sessionId);
			const last = messages.at(-1);
			if (!last) {
				return undefined;
			}
			return {
				...(last.id ? { id: last.id } : {}),
				...(last.timestamp ? { timestamp: last.timestamp } : {}),
			};
		},
		async clearSession(sessionId) {
			await fetchHermes(fetchImpl, sessionUrl(baseUrl, sessionId), {
				method: "DELETE",
				headers: authHeaders,
			});
		},
	};
}

export function findRecoveredAssistantMessage(input: {
	messages: readonly HermesSessionMessage[];
	baseline?: HermesMessageMarker;
	userInput: string;
}): HermesSessionMessage | undefined {
	const candidates = messagesAfterBaseline(input.messages, input.baseline);
	const matchingUserIndexes = candidates.flatMap((message, index) =>
		message.role === "user" && message.content === input.userInput
			? [index]
			: [],
	);
	if (matchingUserIndexes.length !== 1) {
		return undefined;
	}
	const userIndex = matchingUserIndexes[0] ?? -1;
	for (let index = userIndex + 1; index < candidates.length; index += 1) {
		const message = candidates[index];
		if (!message) {
			return undefined;
		}
		if (message.role === "user") {
			return undefined;
		}
		if (message.role === "assistant" && message.content.trim()) {
			return message;
		}
	}
	return undefined;
}

function messagesAfterBaseline(
	messages: readonly HermesSessionMessage[],
	baseline: HermesMessageMarker | undefined,
): HermesSessionMessage[] {
	if (!baseline?.id && !baseline?.timestamp) {
		return [...messages];
	}
	const baselineIndex = messages.findIndex(
		(message) =>
			(Boolean(baseline.id) && message.id === baseline.id) ||
			(Boolean(baseline.timestamp) && message.timestamp === baseline.timestamp),
	);
	if (baselineIndex >= 0) {
		return messages.slice(baselineIndex + 1);
	}
	const baselineTimestamp = baseline.timestamp;
	return baselineTimestamp
		? messages.filter((message) => {
				const timestamp = message.timestamp;
				return timestamp ? timestamp > baselineTimestamp : false;
			})
		: [...messages];
}

async function fetchHermes(
	fetchImpl: typeof fetch,
	input: string,
	init: RequestInit,
	acceptedStatuses: readonly number[] = [],
): Promise<Response> {
	let response: Response;
	try {
		response = await fetchImpl(input, init);
	} catch (error) {
		throw new HermesApiError({
			message: error instanceof Error ? error.message : "Hermes request failed",
			retryable: true,
			ambiguous: init.method === "POST",
		});
	}
	if (response.ok || acceptedStatuses.includes(response.status)) {
		return response;
	}
	throw new HermesApiError({
		message: `Hermes request failed with status ${response.status}`,
		status: response.status,
		retryable: ![400, 401, 403, 404, 422].includes(response.status),
		ambiguous:
			init.method === "POST" &&
			![400, 401, 403, 404, 422].includes(response.status),
	});
}

function sessionsUrl(baseUrl: string): string {
	return `${baseUrl}/api/sessions`;
}

function sessionUrl(baseUrl: string, sessionId: string): string {
	return `${baseUrl}/api/sessions/${encodeSessionId(sessionId)}`;
}

function chatUrl(baseUrl: string, sessionId: string): string {
	return `${baseUrl}/api/sessions/${encodeSessionId(sessionId)}/chat`;
}

function messagesUrl(baseUrl: string, sessionId: string): string {
	return `${baseUrl}/api/sessions/${encodeSessionId(sessionId)}/messages`;
}

function encodeSessionId(sessionId: string): string {
	if (sessionId.includes("/")) {
		throw new HermesApiError({
			message: "Hermes session ID must not contain /",
			retryable: false,
		});
	}
	return encodeURIComponent(sessionId);
}

function extractAssistantText(body: unknown): string {
	if (!body || typeof body !== "object") {
		return "";
	}
	const record = body as Record<string, unknown>;
	for (const key of ["text", "content", "message", "response", "output_text"]) {
		const value = record[key];
		if (typeof value === "string") {
			return value;
		}
	}
	for (const key of ["message", "response"]) {
		const text = extractContentStrings(record[key]).join("\n").trim();
		if (text) {
			return text;
		}
	}
	const output = record.output;
	if (Array.isArray(output)) {
		return output
			.flatMap((item) => extractContentStrings(item))
			.join("\n")
			.trim();
	}
	return "";
}

function extractMessages(body: unknown): HermesSessionMessage[] {
	const values = extractMessageValues(body);
	return values.flatMap((value) => {
		if (!value || typeof value !== "object") {
			return [];
		}
		const record = value as Record<string, unknown>;
		const role = typeof record.role === "string" ? record.role : undefined;
		const content =
			typeof record.content === "string"
				? record.content
				: extractContentStrings(record.content).join("\n").trim();
		if (!role || !content) {
			return [];
		}
		const id = normalizeMessageMarker(record.id);
		const timestamp = normalizeMessageMarker(record.timestamp);
		return [
			{
				role,
				content,
				...(id ? { id } : {}),
				...(timestamp ? { timestamp } : {}),
			},
		];
	});
}

function extractMessageValues(body: unknown): unknown[] {
	if (Array.isArray(body)) {
		return body;
	}
	if (!body || typeof body !== "object") {
		return [];
	}
	const record = body as Record<string, unknown>;
	for (const key of ["messages", "data"]) {
		const value = record[key];
		if (Array.isArray(value)) {
			return value;
		}
	}
	return [];
}

function normalizeMessageMarker(value: unknown): string | undefined {
	if (typeof value === "string") {
		return value;
	}
	return typeof value === "number" && Number.isFinite(value)
		? String(value)
		: undefined;
}

function extractContentStrings(value: unknown): string[] {
	if (typeof value === "string") {
		return [value];
	}
	if (Array.isArray(value)) {
		return value.flatMap(extractContentStrings);
	}
	if (!value || typeof value !== "object") {
		return [];
	}
	const record = value as Record<string, unknown>;
	return ["text", "content", "value"].flatMap((key) =>
		typeof record[key] === "string" ? [record[key]] : [],
	);
}
