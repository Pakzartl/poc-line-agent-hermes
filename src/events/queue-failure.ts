import {
	type HilArtifactEvidence,
	type HilArtifactFinding,
	type HilArtifactV1,
	hilArtifactVersion,
} from "../capabilities/artifact";

export const queueFailureEventVersion = "queue-failure/v1" as const;

export type QueueFailureClassification =
	| "timeout"
	| "auth"
	| "config"
	| "data"
	| "dependency"
	| "unknown";

export type QueueFailureEventV1 = {
	version: typeof queueFailureEventVersion;
	eventId: string;
	queue: string;
	jobName: string;
	failedAt: string;
	attempts: number;
	maxAttempts?: number;
	error: {
		message: string;
		name?: string;
		stack?: string;
	};
	payload?: unknown;
	entity?: Record<string, unknown>;
	logs?: string[];
	recentDeploys?: string[];
	recentConfigChanges?: string[];
};

export type QueueFailureIngestResult =
	| { ok: true; idempotencyKey: string; artifact: HilArtifactV1 }
	| { ok: false; status: number; error: string };

export type QueueFailureArtifactResult = Extract<
	QueueFailureIngestResult,
	{ ok: true }
>;

const maxBodyBytes = 64_000;
const maxText = 1_200;
const maxArrayItems = 5;

export async function ingestQueueFailureEvent(input: {
	body: string;
	signature: string | null;
	timestamp: string | null;
	secret: string;
	now?: Date;
}): Promise<QueueFailureIngestResult> {
	if (!input.secret.trim()) {
		return {
			ok: false,
			status: 503,
			error: "queue failure ingestion is not configured",
		};
	}
	if (new TextEncoder().encode(input.body).byteLength > maxBodyBytes) {
		return { ok: false, status: 413, error: "payload too large" };
	}
	const now = input.now ?? new Date();
	const timestamp = parseSignatureTimestamp(input.timestamp);
	if (
		timestamp === undefined ||
		Math.abs(now.getTime() - timestamp * 1_000) > 5 * 60 * 1_000
	) {
		return { ok: false, status: 401, error: "stale event signature" };
	}
	if (
		!(await verifyQueueFailureSignature(
			input.body,
			input.signature,
			input.secret,
			String(timestamp),
		))
	) {
		return { ok: false, status: 401, error: "invalid event signature" };
	}
	let value: unknown;
	try {
		value = JSON.parse(input.body) as unknown;
	} catch {
		return { ok: false, status: 400, error: "invalid JSON" };
	}
	const event = parseQueueFailureEvent(value);
	if (!event.ok) {
		return { ok: false, status: 400, error: event.error };
	}
	return createQueueFailureArtifactResult(event.value, now);
}

export async function createQueueFailureArtifactResult(
	event: QueueFailureEventV1,
	now = new Date(),
): Promise<QueueFailureArtifactResult> {
	const idempotencyKey = await sha256(
		`${event.version}:${event.queue}:${event.jobName}:${event.eventId}`,
	);
	return {
		ok: true,
		idempotencyKey,
		artifact: buildQueueFailureArtifact(event, {
			idempotencyKey,
			now,
		}),
	};
}

export async function verifyQueueFailureSignature(
	body: string,
	signature: string | null,
	secret: string,
	timestamp: string,
): Promise<boolean> {
	const expected = await hmacHex(`${timestamp}.${body}`, secret);
	const provided = normalizeSignature(signature);
	if (!provided || provided.length !== expected.length) {
		return false;
	}
	return timingSafeEqualHex(provided, expected);
}

function parseSignatureTimestamp(value: string | null): number | undefined {
	if (!value || !/^\d{10}$/.test(value)) return undefined;
	const timestamp = Number(value);
	return Number.isSafeInteger(timestamp) ? timestamp : undefined;
}

export function buildQueueFailureArtifact(
	event: QueueFailureEventV1,
	input: { idempotencyKey: string; now: Date },
): HilArtifactV1 {
	const classification = classifyQueueFailure(event);
	const evidence: HilArtifactEvidence[] = [
		{
			label: "Failure",
			summary: sanitizeText(
				`${event.error.name ? `${event.error.name}: ` : ""}${event.error.message}`,
			),
			source: event.queue,
		},
		{
			label: "Retries",
			summary: `${event.attempts}${event.maxAttempts ? `/${event.maxAttempts}` : ""} attempts exhausted`,
		},
		...optionalJsonEvidence("Payload", event.payload),
		...optionalJsonEvidence("Related entity", event.entity),
		...boundedTextList("Log", event.logs),
		...boundedTextList("Recent deploy", event.recentDeploys),
		...boundedTextList("Recent config", event.recentConfigChanges),
	];
	const findings: HilArtifactFinding[] = [
		{
			title: `Likely ${classification} queue failure`,
			summary: failureSummary(classification),
			severity: classification === "unknown" ? "medium" : "high",
			evidence: ["Failure", "Retries"],
		},
	];
	return {
		version: hilArtifactVersion,
		artifactId: `artifact_queue_failure_${event.eventId}`,
		title: `Queue failure: ${event.jobName}`,
		capability: "queue-failure",
		status: "failed",
		objective:
			"Prepare a one-screen human-in-the-loop artifact for a failed queue job.",
		source: {
			kind: "event",
			eventId: event.eventId,
			jobId: event.jobName,
		},
		evidence,
		findings,
		risks: [
			{
				title: "Retry exhaustion",
				impact:
					"The job will not recover automatically unless a human requeues or fixes the cause.",
				likelihood: "high",
				mitigation:
					"Inspect the evidence, fix the classified cause, then retry from the owning queue tool.",
			},
		],
		humanActions: [
			{
				label: "Triage owner",
				description:
					"Review logs, payload, related entity, and recent deploy/config changes.",
				required: true,
			},
		],
		recommendedAction: recommendedAction(classification),
		metadata: {
			createdAt: input.now.toISOString(),
			correlationId: input.idempotencyKey,
			tags: ["event", "queue", classification],
			inputs: {
				queue: event.queue,
				jobName: event.jobName,
				attempts: event.attempts,
				classification,
			},
		},
	};
}

export function classifyQueueFailure(
	event: Pick<QueueFailureEventV1, "error" | "logs" | "recentConfigChanges">,
): QueueFailureClassification {
	const haystack = [
		event.error.name,
		event.error.message,
		event.error.stack,
		...(event.logs ?? []),
		...(event.recentConfigChanges ?? []),
	]
		.filter(Boolean)
		.join("\n")
		.toLowerCase();
	if (/\b(timeout|timed out|deadline|etimedout|econnreset)\b/.test(haystack)) {
		return "timeout";
	}
	if (
		/\b(unauthorized|forbidden|permission|jwt|token|credential|401|403)\b/.test(
			haystack,
		)
	) {
		return "auth";
	}
	if (
		/\b(config|env|missing|required|secret|invalid url|misconfigured)\b/.test(
			haystack,
		)
	) {
		return "config";
	}
	if (
		/\b(validation|schema|null|undefined|not found|duplicate|constraint)\b/.test(
			haystack,
		)
	) {
		return "data";
	}
	if (
		/\b(upstream|dependency|connect|503|502|504|rate limit|redis|postgres|github)\b/.test(
			haystack,
		)
	) {
		return "dependency";
	}
	return "unknown";
}

function parseQueueFailureEvent(
	value: unknown,
): { ok: true; value: QueueFailureEventV1 } | { ok: false; error: string } {
	if (!value || typeof value !== "object") {
		return { ok: false, error: "event must be an object" };
	}
	const item = value as Record<string, unknown>;
	const error = item.error as Record<string, unknown> | undefined;
	if (
		item.version !== queueFailureEventVersion ||
		typeof item.eventId !== "string" ||
		typeof item.queue !== "string" ||
		typeof item.jobName !== "string" ||
		typeof item.failedAt !== "string" ||
		typeof item.attempts !== "number" ||
		!error ||
		typeof error.message !== "string"
	) {
		return { ok: false, error: "event does not match queue-failure/v1" };
	}
	if (
		!Number.isInteger(item.attempts) ||
		item.attempts < 1 ||
		item.attempts > 100
	) {
		return {
			ok: false,
			error: "attempts must be an integer between 1 and 100",
		};
	}
	if (!Number.isFinite(Date.parse(item.failedAt))) {
		return { ok: false, error: "failedAt must be an ISO-8601 timestamp" };
	}
	if (
		typeof item.maxAttempts === "number" &&
		(!Number.isInteger(item.maxAttempts) ||
			item.maxAttempts < 1 ||
			item.maxAttempts > 100 ||
			item.attempts < item.maxAttempts)
	) {
		return {
			ok: false,
			error: "maxAttempts must be exhausted and between 1 and 100",
		};
	}
	return {
		ok: true,
		value: {
			version: queueFailureEventVersion,
			eventId: sanitizeId(item.eventId),
			queue: sanitizeId(item.queue),
			jobName: sanitizeId(item.jobName),
			failedAt: sanitizeText(item.failedAt),
			attempts: item.attempts,
			maxAttempts:
				typeof item.maxAttempts === "number" &&
				Number.isInteger(item.maxAttempts)
					? item.maxAttempts
					: undefined,
			error: {
				message: sanitizeText(error.message),
				name:
					typeof error.name === "string" ? sanitizeText(error.name) : undefined,
				stack:
					typeof error.stack === "string"
						? sanitizeText(error.stack)
						: undefined,
			},
			payload: sanitizeUnknown(item.payload),
			entity: sanitizeRecord(item.entity),
			logs: sanitizeTextArray(item.logs),
			recentDeploys: sanitizeTextArray(item.recentDeploys),
			recentConfigChanges: sanitizeTextArray(item.recentConfigChanges),
		},
	};
}

function boundedTextList(
	label: string,
	values: readonly string[] | undefined,
): HilArtifactEvidence[] {
	return (values ?? []).slice(0, maxArrayItems).map((value, index) => ({
		label: `${label} ${index + 1}`,
		summary: sanitizeText(value),
	}));
}

function optionalJsonEvidence(
	label: string,
	value: unknown,
): HilArtifactEvidence[] {
	if (value === undefined) {
		return [];
	}
	return [
		{
			label,
			summary: sanitizeText(JSON.stringify(value)),
		},
	];
}

function sanitizeRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (sanitizeUnknown(value) as Record<string, unknown>)
		: undefined;
}

function sanitizeUnknown(value: unknown, depth = 0): unknown {
	if (depth > 3) {
		return "[max-depth]";
	}
	if (typeof value === "string") {
		return sanitizeText(value);
	}
	if (
		typeof value === "number" ||
		typeof value === "boolean" ||
		value === null
	) {
		return value;
	}
	if (Array.isArray(value)) {
		return value
			.slice(0, maxArrayItems)
			.map((item) => sanitizeUnknown(item, depth + 1));
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.slice(0, 20)
				.map(([key, item]) => [
					sanitizeText(key).slice(0, 80),
					isSecretKey(key) ? "[redacted]" : sanitizeUnknown(item, depth + 1),
				]),
		);
	}
	return undefined;
}

function sanitizeTextArray(value: unknown): string[] | undefined {
	return Array.isArray(value)
		? value
				.filter((item): item is string => typeof item === "string")
				.slice(0, maxArrayItems)
				.map(sanitizeText)
		: undefined;
}

function sanitizeText(value: string): string {
	return value
		.replace(
			/(authorization|token|secret|password|api[_-]?key)=\S+/gi,
			"$1=[redacted]",
		)
		.replace(
			/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
			"[redacted-email]",
		)
		.slice(0, maxText);
}

function sanitizeId(value: string): string {
	return sanitizeText(value)
		.replace(/[^\w./:-]+/g, "-")
		.slice(0, 160);
}

function isSecretKey(key: string): boolean {
	return /(authorization|token|secret|password|api[_-]?key|credential)/i.test(
		key,
	);
}

function failureSummary(classification: QueueFailureClassification): string {
	return {
		timeout: "The evidence points to a deadline or network timeout.",
		auth: "The evidence points to a permission, token, or credential problem.",
		config: "The evidence points to missing or invalid configuration.",
		data: "The evidence points to invalid input, missing records, or data constraints.",
		dependency:
			"The evidence points to an upstream dependency or external service.",
		unknown: "The evidence is not specific enough to classify confidently.",
	}[classification];
}

function recommendedAction(classification: QueueFailureClassification): string {
	return {
		timeout:
			"Check downstream latency and retry with backoff after confirming the job is idempotent.",
		auth: "Rotate or repair the affected credential, then retry the job.",
		config:
			"Compare recent config/deploy changes with the previous healthy run.",
		data: "Inspect the related entity and payload shape before retrying.",
		dependency: "Check upstream health/rate limits and retry after recovery.",
		unknown: "Collect one more log sample and inspect the owning queue worker.",
	}[classification];
}

async function hmacHex(body: string, secret: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(body),
	);
	return toHex(new Uint8Array(signature));
}

async function sha256(value: string): Promise<string> {
	const hash = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return toHex(new Uint8Array(hash));
}

function normalizeSignature(value: string | null): string | undefined {
	return value
		?.trim()
		.replace(/^sha256=/, "")
		.toLowerCase();
}

function timingSafeEqualHex(a: string, b: string): boolean {
	let diff = 0;
	for (let index = 0; index < a.length; index += 1) {
		diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
	}
	return diff === 0;
}

function toHex(bytes: Uint8Array): string {
	return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
