export type CapabilityJobStatus =
	| "queued"
	| "running"
	| "waiting_approval"
	| "completed"
	| "failed"
	| "cancelled";

export type CapabilityApprovalStatus =
	| "pending"
	| "approved"
	| "rejected"
	| "expired";

export type CapabilityAuditEntry = {
	sequence: number;
	timestamp: string;
	type: string;
	status: CapabilityJobStatus;
	detail?: string;
	actorUserId?: string;
};

export type CapabilityJobRecord = {
	jobId: string;
	capability: string;
	status: CapabilityJobStatus;
	userId: string;
	guildId?: string;
	channelId?: string;
	actionDigest: string;
	objective: string;
	createdAt: string;
	updatedAt: string;
	expiresAt: string;
	metadata: Record<string, string>;
	audit: readonly CapabilityAuditEntry[];
};

export type CapabilityApprovalRecord = {
	approvalId: string;
	jobId: string;
	userId: string;
	guildId?: string;
	action: string;
	actionDigest: string;
	status: CapabilityApprovalStatus;
	createdAt: string;
	expiresAt: string;
	decidedAt?: string;
	decidedByUserId?: string;
};

export type CreateCapabilityJobInput = {
	jobId?: string;
	capability: string;
	userId: string;
	guildId?: string;
	channelId?: string;
	actionDigest: string;
	objective: string;
	ttlSeconds?: number;
	metadata?: Record<string, string>;
	now?: string;
};

export type TransitionCapabilityJobInput = {
	jobId: string;
	from?: CapabilityJobStatus | readonly CapabilityJobStatus[];
	to: CapabilityJobStatus;
	detail?: string;
	actorUserId?: string;
	now?: string;
};

export type RequestCapabilityApprovalInput = {
	approvalId?: string;
	jobId: string;
	userId: string;
	guildId?: string;
	action: string;
	actionDigest: string;
	ttlSeconds?: number;
	now?: string;
};

export type DecideCapabilityApprovalInput = {
	approvalId: string;
	decision: "approved" | "rejected";
	userId: string;
	guildId?: string;
	actionDigest: string;
	now?: string;
};

export type CapabilityJobStore = {
	createJob(input: CreateCapabilityJobInput): Promise<CapabilityJobRecord>;
	getJob(jobId: string): Promise<CapabilityJobRecord | undefined>;
	transitionJob(
		input: TransitionCapabilityJobInput,
	): Promise<CapabilityJobRecord | undefined>;
	requestApproval(
		input: RequestCapabilityApprovalInput,
	): Promise<CapabilityApprovalRecord>;
	getApproval(
		approvalId: string,
	): Promise<CapabilityApprovalRecord | undefined>;
	decideApproval(
		input: DecideCapabilityApprovalInput,
	): Promise<CapabilityApprovalRecord | undefined>;
};

export type CapabilityJobCoordinatorStub = {
	createCapabilityJob(
		input: CreateCapabilityJobInput,
	): Promise<CapabilityJobRecord>;
	getCapabilityJob(jobId: string): Promise<CapabilityJobRecord | undefined>;
	transitionCapabilityJob(
		input: TransitionCapabilityJobInput,
	): Promise<CapabilityJobRecord | undefined>;
	requestCapabilityApproval(
		input: RequestCapabilityApprovalInput,
	): Promise<CapabilityApprovalRecord>;
	getCapabilityApproval(
		approvalId: string,
	): Promise<CapabilityApprovalRecord | undefined>;
	decideCapabilityApproval(
		input: DecideCapabilityApprovalInput,
	): Promise<CapabilityApprovalRecord | undefined>;
};

export type CapabilityJobCoordinatorNamespace = {
	getByName(name: string): CapabilityJobCoordinatorStub;
};

const defaultJobTtlSeconds = 86_400;
const defaultApprovalTtlSeconds = 900;
const validTransitions: ReadonlyMap<
	CapabilityJobStatus,
	readonly CapabilityJobStatus[]
> = new Map([
	["queued", ["running", "cancelled", "failed"]],
	["running", ["waiting_approval", "completed", "failed", "cancelled"]],
	["waiting_approval", ["running", "completed", "failed", "cancelled"]],
	["completed", []],
	["failed", []],
	["cancelled", []],
]);

export function createMemoryCapabilityJobStore(): CapabilityJobStore {
	const jobs = new Map<string, CapabilityJobRecord>();
	const approvals = new Map<string, CapabilityApprovalRecord>();
	return {
		async createJob(input) {
			const now = input.now ?? new Date().toISOString();
			const jobId = input.jobId ?? crypto.randomUUID();
			const existing = jobs.get(jobId);
			if (existing) {
				if (
					existing.actionDigest !== input.actionDigest ||
					existing.userId !== input.userId ||
					existing.capability !== input.capability
				) {
					throw new Error("capability job idempotency conflict");
				}
				return existing;
			}
			const record: CapabilityJobRecord = {
				jobId,
				capability: input.capability,
				status: "queued",
				userId: input.userId,
				...(input.guildId ? { guildId: input.guildId } : {}),
				...(input.channelId ? { channelId: input.channelId } : {}),
				actionDigest: input.actionDigest,
				objective: input.objective,
				createdAt: now,
				updatedAt: now,
				expiresAt: ttl(now, input.ttlSeconds ?? defaultJobTtlSeconds),
				metadata: { ...(input.metadata ?? {}) },
				audit: [auditEntry(1, now, "created", "queued", input.userId)],
			};
			jobs.set(jobId, record);
			return record;
		},
		async getJob(jobId) {
			return jobs.get(jobId);
		},
		async transitionJob(input) {
			const current = jobs.get(input.jobId);
			if (!current) {
				return undefined;
			}
			const expected = Array.isArray(input.from)
				? input.from
				: input.from
					? [input.from]
					: undefined;
			if (expected && !expected.includes(current.status)) {
				return current;
			}
			if (current.status === input.to) {
				return current;
			}
			if (!isValidTransition(current.status, input.to)) {
				throw new Error(
					`invalid capability job transition ${current.status} -> ${input.to}`,
				);
			}
			const now = input.now ?? new Date().toISOString();
			const updated: CapabilityJobRecord = {
				...current,
				status: input.to,
				updatedAt: now,
				audit: [
					...current.audit,
					auditEntry(
						current.audit.length + 1,
						now,
						"transition",
						input.to,
						input.actorUserId,
						input.detail,
					),
				],
			};
			jobs.set(input.jobId, updated);
			return updated;
		},
		async requestApproval(input) {
			const job = jobs.get(input.jobId);
			if (!job) {
				throw new Error("capability job not found");
			}
			if (
				job.userId !== input.userId ||
				job.actionDigest !== input.actionDigest
			) {
				throw new Error("capability approval binding conflict");
			}
			const approvalId = input.approvalId ?? crypto.randomUUID();
			const existing = approvals.get(approvalId);
			if (existing) {
				if (
					existing.jobId !== input.jobId ||
					existing.userId !== input.userId ||
					existing.actionDigest !== input.actionDigest
				) {
					throw new Error("capability approval idempotency conflict");
				}
				return expireApproval(existing, input.now);
			}
			const now = input.now ?? new Date().toISOString();
			const record: CapabilityApprovalRecord = {
				approvalId,
				jobId: input.jobId,
				userId: input.userId,
				...(input.guildId ? { guildId: input.guildId } : {}),
				action: input.action,
				actionDigest: input.actionDigest,
				status: "pending",
				createdAt: now,
				expiresAt: ttl(now, input.ttlSeconds ?? defaultApprovalTtlSeconds),
			};
			approvals.set(approvalId, record);
			await this.transitionJob({
				jobId: input.jobId,
				from: ["queued", "running"],
				to: "waiting_approval",
				detail: `approval requested: ${input.action}`,
				actorUserId: input.userId,
				now,
			});
			return record;
		},
		async getApproval(approvalId) {
			const record = approvals.get(approvalId);
			return record ? expireApproval(record) : undefined;
		},
		async decideApproval(input) {
			const current = approvals.get(input.approvalId);
			if (!current) {
				return undefined;
			}
			const fresh = expireApproval(current, input.now);
			if (fresh.status !== "pending") {
				return fresh;
			}
			if (
				fresh.userId !== input.userId ||
				fresh.actionDigest !== input.actionDigest ||
				(input.guildId !== undefined && fresh.guildId !== input.guildId)
			) {
				throw new Error("capability approval decision binding conflict");
			}
			const now = input.now ?? new Date().toISOString();
			const updated: CapabilityApprovalRecord = {
				...fresh,
				status: input.decision,
				decidedAt: now,
				decidedByUserId: input.userId,
			};
			approvals.set(input.approvalId, updated);
			await this.transitionJob({
				jobId: fresh.jobId,
				from: "waiting_approval",
				to: input.decision === "approved" ? "running" : "cancelled",
				detail: `approval ${input.decision}`,
				actorUserId: input.userId,
				now,
			});
			return updated;
		},
	};

	function expireApproval(
		record: CapabilityApprovalRecord,
		now = new Date().toISOString(),
	): CapabilityApprovalRecord {
		if (
			record.status !== "pending" ||
			Date.parse(record.expiresAt) > Date.parse(now)
		) {
			return record;
		}
		const updated: CapabilityApprovalRecord = {
			...record,
			status: "expired",
			decidedAt: now,
		};
		approvals.set(record.approvalId, updated);
		return updated;
	}
}

export function createDurableObjectCapabilityJobStore(input: {
	namespace: CapabilityJobCoordinatorNamespace;
	scopeName: string;
}): CapabilityJobStore {
	const stub = () => input.namespace.getByName(input.scopeName);
	return {
		createJob(jobInput) {
			return stub().createCapabilityJob(jobInput);
		},
		getJob(jobId) {
			return stub().getCapabilityJob(jobId);
		},
		transitionJob(transitionInput) {
			return stub().transitionCapabilityJob(transitionInput);
		},
		requestApproval(approvalInput) {
			return stub().requestCapabilityApproval(approvalInput);
		},
		getApproval(approvalId) {
			return stub().getCapabilityApproval(approvalId);
		},
		decideApproval(decisionInput) {
			return stub().decideCapabilityApproval(decisionInput);
		},
	};
}

export function isValidTransition(
	from: CapabilityJobStatus,
	to: CapabilityJobStatus,
): boolean {
	return validTransitions.get(from)?.includes(to) ?? false;
}

function auditEntry(
	sequence: number,
	timestamp: string,
	type: string,
	status: CapabilityJobStatus,
	actorUserId?: string,
	detail?: string,
): CapabilityAuditEntry {
	return {
		sequence,
		timestamp,
		type,
		status,
		...(detail ? { detail } : {}),
		...(actorUserId ? { actorUserId } : {}),
	};
}

function ttl(now: string, seconds: number): string {
	return new Date(Date.parse(now) + seconds * 1000).toISOString();
}
