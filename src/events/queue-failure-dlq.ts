import type { DiscordReplyClient } from "../discord/reply";
import type { TelegramUpdateStore } from "../telegram/update-store";
import { publishQueueFailureArtifact } from "./queue-failure-handler";
import {
	createQueueFailureArtifactResult,
	type QueueFailureEventV1,
} from "./queue-failure";

export const queueFailureDlqName = "poc-line-agent-telegram-jobs-dlq";

export type QueueFailureDlqDeps = {
	discordChannelId: string;
	discordReplyClient: DiscordReplyClient;
	updateStore: TelegramUpdateStore;
};

export async function processQueueFailureDlqMessage(input: {
	messageId: string;
	body: unknown;
	attempts: number;
	deps: QueueFailureDlqDeps;
	now?: Date;
}): Promise<void> {
	const metadata = queueMessageMetadata(input.body);
	const maxAttempts = Math.max(3, boundedAttempts(input.attempts));
	const event: QueueFailureEventV1 = {
		version: "queue-failure/v1",
		eventId: boundedIdentifier(input.messageId, "unknown-message"),
		queue: queueFailureDlqName,
		jobName: metadata.jobName,
		failedAt: (input.now ?? new Date()).toISOString(),
		attempts: maxAttempts,
		maxAttempts,
		error: {
			name: "QueueRetryExhausted",
			message: "Queue job exhausted retries and entered the dead-letter queue.",
		},
		entity: metadata.entity,
	};
	const result = await createQueueFailureArtifactResult(event, input.now);
	await publishQueueFailureArtifact(result, input.deps);
}

function queueMessageMetadata(value: unknown): {
	jobName: string;
	entity: Record<string, unknown>;
} {
	const record = asRecord(value);
	if (record?.provider === "discord") {
		const job = asRecord(record.job);
		const capability = asRecord(job?.capability);
		const action = boundedIdentifier(
			stringValue(capability?.kind) ?? stringValue(job?.action),
			"agent-job",
		);
		return {
			jobName: `discord:${action}`,
			entity: {
				provider: "discord",
				action,
				requestId: boundedIdentifier(
					stringValue(job?.capabilityJobId) ?? stringValue(job?.interactionId),
					"unknown",
				),
			},
		};
	}
	const action = boundedIdentifier(stringValue(record?.action), "agent-job");
	return {
		jobName: `telegram:${action}`,
		entity: {
			provider: "telegram",
			action,
			requestId: boundedIdentifier(
				stringValue(record?.updateId) ?? stringValue(record?.messageId),
				"unknown",
			),
		},
	};
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function boundedIdentifier(
	value: string | undefined,
	fallback: string,
): string {
	return (value ?? fallback).replace(/[^A-Za-z0-9_.:/-]+/g, "-").slice(0, 160);
}

function boundedAttempts(value: number): number {
	return Number.isInteger(value) ? Math.min(100, Math.max(1, value)) : 1;
}
