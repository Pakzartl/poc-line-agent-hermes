import {
	type HilArtifactV1,
	renderHilArtifactMarkdown,
	safeArtifactFilename,
} from "../capabilities/artifact";
import type { DiscordReplyClient } from "../discord/reply";
import type { TelegramUpdateStore } from "../telegram/update-store";
import {
	type QueueFailureArtifactResult,
	ingestQueueFailureEvent,
} from "./queue-failure";

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
		timestamp: request.headers.get("x-javis-timestamp"),
		secret: deps.secret,
	});
	if (!result.ok) {
		return Response.json({ error: result.error }, { status: result.status });
	}

	const delivery = await publishQueueFailureArtifact(result, deps);
	return Response.json(
		{
			accepted: true,
			...delivery,
			artifact: result.artifact,
		},
		{ status: 202 },
	);
}

export async function publishQueueFailureArtifact(
	result: QueueFailureArtifactResult,
	deps: Omit<QueueFailureHandlerDeps, "secret">,
): Promise<{
	duplicate: boolean;
	artifactId: string;
	postedToDiscord: boolean;
}> {
	const providerSessionId = `discord:event:queue-failure:${deps.discordChannelId || "http"}`;
	const idempotencyKey = `queue-failure:${result.idempotencyKey}`;
	const markdown = renderHilArtifactMarkdown(result.artifact);
	const replyHash = await sha256(markdown);
	const claim = await deps.updateStore.claim({
		providerSessionId,
		idempotencyKey,
		canonicalInputHash: result.idempotencyKey,
		updateId: result.artifact.source.eventId ?? result.idempotencyKey,
	});
	if (!claim.claimed) {
		if (
			claim.record?.status === "replying" &&
			claim.record.replyContentHash === replyHash &&
			claim.record.replyContent === markdown
		) {
			await deliverQueueFailureArtifact(result.artifact, markdown, deps);
			await deps.updateStore.complete({
				providerSessionId,
				idempotencyKey,
				replyContentHash: replyHash,
			});
			return {
				duplicate: false,
				artifactId: idempotencyKey,
				postedToDiscord: Boolean(deps.discordChannelId),
			};
		}
		return {
			duplicate: true,
			artifactId: idempotencyKey,
			postedToDiscord: false,
		};
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
		return {
			duplicate: true,
			artifactId: idempotencyKey,
			postedToDiscord: false,
		};
	}

	const checkpoint = await deps.updateStore.beginReply({
		providerSessionId,
		idempotencyKey,
		replyContent: markdown,
		replyContentHash: replyHash,
	});
	if (checkpoint.kind !== "ready") {
		throw new Error("queue failure artifact reply checkpoint is not ready");
	}
	await deliverQueueFailureArtifact(result.artifact, markdown, deps);
	await deps.updateStore.complete({
		providerSessionId,
		idempotencyKey,
		replyContentHash: replyHash,
	});
	return {
		duplicate: false,
		artifactId: idempotencyKey,
		postedToDiscord: Boolean(deps.discordChannelId),
	};
}

async function deliverQueueFailureArtifact(
	artifact: HilArtifactV1,
	markdown: string,
	deps: Omit<QueueFailureHandlerDeps, "secret">,
): Promise<void> {
	if (!deps.discordChannelId) return;
	await deps.discordReplyClient.replyToChannel(
		deps.discordChannelId,
		queueFailureSummary(artifact),
		undefined,
		{
			attachment: {
				filename: safeArtifactFilename({
					title: artifact.title,
					capability: artifact.capability,
					createdAt: artifact.metadata.createdAt,
				}),
				contentType: "text/markdown; charset=utf-8",
				data: markdown,
			},
		},
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
