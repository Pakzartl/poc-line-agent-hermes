import type {
	BeginReplyInput,
	BeginReplyResult,
	DispatchLeaseInput,
	RetryPreReplyInput,
	TelegramCoordinatorDispatchResult,
	TelegramCoordinatorRecord,
	TelegramCoordinatorTerminalInput,
	TelegramSessionCoordinator,
	TelegramUpdateClaimInput,
	TelegramUpdateClaimResult,
} from "./session-coordinator";

export type TelegramUpdateStore = {
	claim(input: TelegramUpdateClaimInput): Promise<TelegramUpdateClaimResult>;
	complete(input: TelegramTerminalInput): Promise<void>;
	fail(input: TelegramTerminalInput): Promise<void>;
	markUncertain(input: TelegramTerminalInput): Promise<void>;
	release(input: TelegramTerminalInput): Promise<void>;
	retryPreReply(input: RetryPreReplyInput): Promise<void>;
	beginReply(input: BeginReplyInput): Promise<BeginReplyResult>;
	dispatchLease(
		input: DispatchLeaseInput,
	): Promise<TelegramCoordinatorDispatchResult>;
};

export type TelegramTerminalInput = {
	providerSessionId: string;
	idempotencyKey: string;
	terminalReason?: string;
	replyContentHash?: string;
	recoveredAssistantMessageId?: string;
	recoveredAssistantContentHash?: string;
};

type KvUpdateNamespace = {
	get(key: string): Promise<string | null>;
	put(
		key: string,
		value: string,
		options: { expirationTtl: number },
	): Promise<void>;
	delete(key: string): Promise<void>;
};

export type TelegramSessionCoordinatorNamespace = {
	getByName(name: string): TelegramSessionCoordinatorStub;
};

export type TelegramSessionCoordinatorStub = Pick<
	TelegramSessionCoordinator,
	| "claim"
	| "dispatchLease"
	| "complete"
	| "fail"
	| "markUncertain"
	| "release"
	| "retryPreReply"
	| "beginReply"
>;

const processingUpdateTtlSeconds = 3_600;
const processedUpdateTtlSeconds = 86_400;

export function createDurableObjectTelegramUpdateStore(
	namespace: TelegramSessionCoordinatorNamespace,
): TelegramUpdateStore {
	return {
		claim(input) {
			return namespace.getByName(input.providerSessionId).claim(input);
		},
		complete(input) {
			return namespace.getByName(input.providerSessionId).complete(input);
		},
		fail(input) {
			return namespace.getByName(input.providerSessionId).fail(input);
		},
		markUncertain(input) {
			return namespace.getByName(input.providerSessionId).markUncertain(input);
		},
		release(input) {
			return namespace.getByName(input.providerSessionId).release(input);
		},
		retryPreReply(input) {
			return namespace.getByName(input.providerSessionId).retryPreReply(input);
		},
		beginReply(input) {
			return namespace.getByName(input.providerSessionId).beginReply(input);
		},
		dispatchLease(input) {
			return namespace.getByName(input.providerSessionId).dispatchLease(input);
		},
	};
}

export function createKvTelegramUpdateStore(
	namespace: KvUpdateNamespace,
): TelegramUpdateStore {
	return {
		async claim(input) {
			const key = input.idempotencyKey;
			if ((await namespace.get(key)) !== null) {
				return { claimed: false, duplicate: true };
			}
			const record = passThroughRecord(input, 1);
			await namespace.put(key, JSON.stringify(record), {
				expirationTtl: processingUpdateTtlSeconds,
			});
			return { claimed: true, duplicate: false, record };
		},
		async complete(input) {
			await namespace.put(input.idempotencyKey, "processed", {
				expirationTtl: processedUpdateTtlSeconds,
			});
		},
		async fail(input) {
			await namespace.put(input.idempotencyKey, "failed", {
				expirationTtl: processedUpdateTtlSeconds,
			});
		},
		async markUncertain(input) {
			await namespace.put(input.idempotencyKey, "uncertain", {
				expirationTtl: processedUpdateTtlSeconds,
			});
		},
		async release(input) {
			await namespace.delete(input.idempotencyKey);
		},
		async retryPreReply(input) {
			await namespace.delete(input.idempotencyKey);
		},
		async beginReply(input) {
			return {
				kind: "ready",
				record: {
					...passThroughRecord(input, 1),
					status: "replying",
					replyContentHash: input.replyContentHash,
					replyContent: input.replyContent,
					replyTimestamp: new Date().toISOString(),
				},
			};
		},
		async dispatchLease(input) {
			return {
				kind: "leased",
				record: passThroughRecord(input, input.sessionSequence ?? 1),
			};
		},
	};
}

export function createPassThroughTelegramUpdateStore(): TelegramUpdateStore {
	return {
		claim: async (input) => ({
			claimed: true,
			duplicate: false,
			record: passThroughRecord(input, 1),
		}),
		complete: async () => undefined,
		fail: async () => undefined,
		markUncertain: async () => undefined,
		release: async () => undefined,
		retryPreReply: async () => undefined,
		beginReply: async (input) => ({
			kind: "ready",
			record: {
				...passThroughRecord(input, 1),
				status: "replying",
				replyContentHash: input.replyContentHash,
				replyContent: input.replyContent,
				replyTimestamp: new Date().toISOString(),
			},
		}),
		dispatchLease: async (input) => ({
			kind: "leased",
			record: passThroughRecord(input, input.sessionSequence ?? 1),
		}),
	};
}

function passThroughRecord(
	input: TelegramUpdateClaimInput | DispatchLeaseInput | BeginReplyInput,
	sessionSequence: number,
): TelegramCoordinatorRecord {
	const dispatchInput = hasDispatchFields(input) ? input : undefined;
	const claimInput = hasClaimFields(input) ? input : undefined;
	return {
		version: 1,
		status: "claimed",
		key: input.idempotencyKey,
		sessionSequence,
		generation: dispatchInput?.generation ?? "passthrough",
		providerSessionId: input.providerSessionId,
		canonicalInputHash:
			"canonicalInputHash" in input ? input.canonicalInputHash : "reply",
		baselineLastHermesMessageId: dispatchInput?.baselineLastHermesMessageId,
		baselineLastHermesMessageTimestamp:
			dispatchInput?.baselineLastHermesMessageTimestamp,
		updateId: claimInput?.updateId ?? dispatchInput?.updateId,
		messageId: claimInput?.messageId ?? dispatchInput?.messageId,
		providerTimestamp:
			claimInput?.providerTimestamp ?? dispatchInput?.providerTimestamp,
		attemptCount: 0,
		expiresAt: new Date(
			Date.now() + processedUpdateTtlSeconds * 1000,
		).toISOString(),
		dispatchTimestamp: undefined,
		terminalReason: undefined,
	};
}

function hasDispatchFields(
	input: TelegramUpdateClaimInput | DispatchLeaseInput | BeginReplyInput,
): input is DispatchLeaseInput {
	return "sessionSequence" in input || "generation" in input;
}

function hasClaimFields(
	input: TelegramUpdateClaimInput | DispatchLeaseInput | BeginReplyInput,
): input is TelegramUpdateClaimInput {
	return "canonicalInputHash" in input && !hasDispatchFields(input);
}

export function toCoordinatorTerminalInput(
	input: TelegramTerminalInput,
): TelegramCoordinatorTerminalInput {
	return input;
}
