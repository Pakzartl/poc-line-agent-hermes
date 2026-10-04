import type { TelegramSessionCoordinator } from "./session-coordinator";

export type TelegramSourceSelectionPhase =
	| "repository"
	| "branch"
	| "custom_branch";

export type TelegramSourceSelection = {
	flowId: string;
	userId: string;
	question: string;
	messageId?: number;
	phase: TelegramSourceSelectionPhase;
	repositories: readonly string[];
	repository?: string;
	branches: readonly string[];
	expiresAt: string;
};

export type TelegramSourceSelectionKey = {
	providerSessionId: string;
	userId: string;
	flowId?: string;
};

export type BeginTelegramSourceSelectionInput = {
	providerSessionId: string;
	userId: string;
	question: string;
	repositories: readonly string[];
	messageId?: number;
};

export type SetTelegramSourceRepositoryInput = TelegramSourceSelectionKey & {
	flowId: string;
	repository: string;
	branches: readonly string[];
};

export type TelegramSourceSelectionStore = {
	begin(
		input: BeginTelegramSourceSelectionInput,
	): Promise<TelegramSourceSelection>;
	get(
		input: TelegramSourceSelectionKey,
	): Promise<TelegramSourceSelection | undefined>;
	getLatest(
		input: Omit<TelegramSourceSelectionKey, "flowId">,
	): Promise<TelegramSourceSelection | undefined>;
	setRepository(
		input: SetTelegramSourceRepositoryInput,
	): Promise<TelegramSourceSelection | undefined>;
	waitForCustomBranch(
		input: TelegramSourceSelectionKey & { flowId: string },
	): Promise<TelegramSourceSelection | undefined>;
	consume(
		input: TelegramSourceSelectionKey & { flowId: string },
	): Promise<TelegramSourceSelection | undefined>;
	clear(input: { providerSessionId: string }): Promise<void>;
};

export type TelegramSourceSelectionCoordinatorStub = Pick<
	TelegramSessionCoordinator,
	| "beginSourceSelection"
	| "getSourceSelection"
	| "getLatestSourceSelection"
	| "setSourceRepository"
	| "waitForCustomBranch"
	| "consumeSourceSelection"
	| "clearSourceSelection"
>;

export type TelegramSourceSelectionCoordinatorNamespace = {
	getByName(name: string): TelegramSourceSelectionCoordinatorStub;
};

export function createDurableObjectTelegramSourceSelectionStore(
	namespace: TelegramSourceSelectionCoordinatorNamespace,
): TelegramSourceSelectionStore {
	return {
		begin(input) {
			return namespace
				.getByName(input.providerSessionId)
				.beginSourceSelection(input);
		},
		get(input) {
			return namespace
				.getByName(input.providerSessionId)
				.getSourceSelection(input);
		},
		getLatest(input) {
			return namespace
				.getByName(input.providerSessionId)
				.getLatestSourceSelection(input);
		},
		setRepository(input) {
			return namespace
				.getByName(input.providerSessionId)
				.setSourceRepository(input);
		},
		waitForCustomBranch(input) {
			return namespace
				.getByName(input.providerSessionId)
				.waitForCustomBranch(input);
		},
		consume(input) {
			return namespace
				.getByName(input.providerSessionId)
				.consumeSourceSelection(input);
		},
		clear(input) {
			return namespace
				.getByName(input.providerSessionId)
				.clearSourceSelection();
		},
	};
}

export function createMemoryTelegramSourceSelectionStore(): TelegramSourceSelectionStore {
	const records = new Map<string, Map<string, TelegramSourceSelection>>();
	return {
		async begin(input) {
			const record = newSourceSelection(input);
			const sessionRecords = currentRecords(records, input.providerSessionId);
			sessionRecords.set(record.flowId, record);
			return record;
		},
		async get(input) {
			return findRecord(records, input);
		},
		async getLatest(input) {
			const sessionRecords = currentRecords(records, input.providerSessionId);
			return [...sessionRecords.values()]
				.reverse()
				.find((record) => record.userId === input.userId);
		},
		async setRepository(input) {
			const record = findRecord(records, input);
			if (!matchesSelection(record, input) || record?.phase !== "repository") {
				return undefined;
			}
			const updated: TelegramSourceSelection = {
				...record,
				phase: "branch",
				repository: input.repository,
				branches: [...input.branches],
			};
			currentRecords(records, input.providerSessionId).set(
				updated.flowId,
				updated,
			);
			return updated;
		},
		async waitForCustomBranch(input) {
			const record = findRecord(records, input);
			if (!matchesSelection(record, input) || record?.phase !== "branch") {
				return undefined;
			}
			const updated = { ...record, phase: "custom_branch" as const };
			currentRecords(records, input.providerSessionId).set(
				updated.flowId,
				updated,
			);
			return updated;
		},
		async consume(input) {
			const record = findRecord(records, input);
			if (!record || !matchesSelection(record, input)) {
				return undefined;
			}
			currentRecords(records, input.providerSessionId).delete(record.flowId);
			return record;
		},
		async clear(input) {
			records.delete(input.providerSessionId);
		},
	};
}

export function newSourceSelection(
	input: BeginTelegramSourceSelectionInput,
): TelegramSourceSelection {
	return {
		flowId: crypto.randomUUID(),
		userId: input.userId,
		question: input.question,
		...(input.messageId !== undefined ? { messageId: input.messageId } : {}),
		phase: "repository",
		repositories: [...input.repositories],
		branches: [],
		expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
	};
}

function currentRecords(
	records: Map<string, Map<string, TelegramSourceSelection>>,
	providerSessionId: string,
): Map<string, TelegramSourceSelection> {
	let sessionRecords = records.get(providerSessionId);
	if (!sessionRecords) {
		sessionRecords = new Map();
		records.set(providerSessionId, sessionRecords);
	}
	for (const [flowId, record] of sessionRecords) {
		if (Date.parse(record.expiresAt) <= Date.now()) {
			sessionRecords.delete(flowId);
		}
	}
	return sessionRecords;
}

function findRecord(
	records: Map<string, Map<string, TelegramSourceSelection>>,
	input: TelegramSourceSelectionKey,
): TelegramSourceSelection | undefined {
	const sessionRecords = currentRecords(records, input.providerSessionId);
	if (input.flowId) {
		const record = sessionRecords.get(input.flowId);
		return matchesSelection(record, input) ? record : undefined;
	}
	return [...sessionRecords.values()]
		.reverse()
		.find(
			(record) =>
				record.userId === input.userId && record.phase === "custom_branch",
		);
}

function matchesSelection(
	record: TelegramSourceSelection | undefined,
	input: TelegramSourceSelectionKey,
): boolean {
	return Boolean(
		record &&
			record.userId === input.userId &&
			(input.flowId === undefined || record.flowId === input.flowId),
	);
}
