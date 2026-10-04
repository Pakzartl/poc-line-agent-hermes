import {
	renderHilArtifactMarkdown,
	safeArtifactFilename,
	type HilArtifactV1,
} from "../capabilities/artifact";
import type { DiscordReplyClient } from "../discord/reply";
import type { TelegramUpdateStore } from "../telegram/update-store";
import { ingestQueueFailureEvent } from "./queue-failure";

export type QueueFailureHandlerDeps = {
	secret: string;
	discordChannelId: string;
	discordReplyClient: DiscordReplyClient;
	updateStore: TelegramUpdateStore;
};

export async function handleQueueFailureEvent(
	request: Request,
	deps: QueueFailureHandlerDeps,
): Promise<Response> {
	if (!deps.secret.trim()) {
		return Response.json(
			{ error: "queue failure capability is not configured" },
			{ status: 503 },
		);
	}
	const body = await request.text();
	const result = await ingestQueueFailureEvent({
		body,
		signature: request.headers.get("x-javis-signature"),
		secret: deps.secret,
	});
	if (!result.ok) {
		return Response.json({ error: result.error }, { status: result.status });
	}

	const providerSessionId = `discord:event:queue-failure:${deps.discordChannelId || "http"}`;
	const idempotencyKey = `queue-failure:${result.idempotencyKey}`;
	const claim = await deps.updateStore.claim({
		providerSessionId,
		idempotencyKey,
		canonicalInputHash: result.idempotencyKey,
		updateId: result.artifact.source.eventId ?? result.idempotencyKey,
	});
	if (!claim.claimed) {
		return Response.json(
			{ accepted: true, duplicate: true, artifactId: idempotencyKey },
			{ status: 202 },
		);
	}
	const lease = await deps.updateStore.dispatchLease({
		providerSessionId,
		idempotencyKey,
		canonicalInputHash: result.idempotencyKey,
		sessionSequence: claim.record?.sessionSequence,
		generation: claim.record?.generation,
		updateId: result.artifact.source.eventId ?? result.idempotencyKey,
	});
	if (lease.kind !== "leased") {
		return Response.json(
			{ accepted: true, duplicate: true, artifactId: idempotencyKey },
			{ status: 202 },
		);
	}

	const markdown = renderHilArtifactMarkdown(result.artifact);
	const replyHash = await sha256(markdown);
	try {
		const checkpoint = await deps.updateStore.beginReply({
			providerSessionId,
			idempotencyKey,
			replyContent: markdown,
			replyContentHash: replyHash,
		});
		if (checkpoint.kind !== "ready") {
			throw new Error("queue failure artifact reply checkpoint is not ready");
		}
		if (deps.discordChannelId) {
			await deps.discordReplyClient.replyToChannel(
				deps.discordChannelId,
				queueFailureSummary(result.artifact),
				undefined,
				{
					attachment: {
						filename: safeArtifactFilename({
							title: result.artifact.title,
							capability: result.artifact.capability,
							createdAt: result.artifact.metadata.createdAt,
						}),
						contentType: "text/markdown; charset=utf-8",
						data: markdown,
					},
				},
			);
		}
		await deps.updateStore.complete({
			providerSessionId,
			idempotencyKey,
			replyContentHash: replyHash,
		});
	} catch (error) {
		await deps.updateStore.fail({
			providerSessionId,
			idempotencyKey,
			terminalReason:
				error instanceof Error
					? error.message
					: "queue failure delivery failed",
		});
		throw error;
	}

	return Response.json(
		{
			accepted: true,
			duplicate: false,
			artifactId: idempotencyKey,
			postedToDiscord: Boolean(deps.discordChannelId),
			artifact: result.artifact,
		},
		{ status: 202 },
	);
}

function queueFailureSummary(artifact: HilArtifactV1): string {
	const finding = artifact.findings[0];
	return [
		`🚨 **${artifact.title}**`,
		finding ? finding.summary : "A queue job exhausted its retries.",
		artifact.recommendedAction
			? `**Next:** ${artifact.recommendedAction}`
			: undefined,
		"Detailed HIL artifact is attached.",
	]
		.filter(Boolean)
		.join("\n\n");
}

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}
