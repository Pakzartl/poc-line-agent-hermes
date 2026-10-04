/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from "cloudflare:workers";
import type {
	CapabilityApprovalRecord,
	CapabilityApprovalStatus,
	CapabilityJobRecord,
	CapabilityJobStatus,
	CreateCapabilityJobInput,
	DecideCapabilityApprovalInput,
	RequestCapabilityApprovalInput,
	TransitionCapabilityJobInput,
} from "../capabilities/job-store";
import { isValidTransition } from "../capabilities/job-store";
import {
	type BeginTelegramSourceSelectionInput,
	newSourceSelection,
	type SetTelegramSourceRepositoryInput,
	type TelegramSourceSelection,
	type TelegramSourceSelectionKey,
} from "./source-selection";

type CoordinatorEnv = Record<string, unknown>;

export type TelegramCoordinatorStatus =
	| "claimed"
	| "dispatched"
	| "replying"
	| "completed"
	| "uncertain"
	| "failed";

export type TelegramCoordinatorRecord = {
	version: 1;
	status: TelegramCoordinatorStatus;
	key: string;
	sessionSequence: number;
	generation: string;
	updateId?: string;
	messageId?: string;
	providerTimestamp?: string;
	providerSessionId: string;
	canonicalInputHash: string;
	baselineLastHermesMessageId?: string;
	baselineLastHermesMessageTimestamp?: string;
	dispatchTimestamp?: string;
	replyTimestamp?: string;
	replyContentHash?: string;
	replyContent?: string;
	attemptCount: number;
	recoveredAssistantMessageId?: string;
	recoveredAssistantContentHash?: string;
	terminalReason?: string;
	expiresAt: string;
};

export type TelegramUpdateClaimInput = {
	providerSessionId: string;
	idempotencyKey: string;
	canonicalInputHash: string;
	updateId?: string;
	messageId?: string;
	providerTimestamp?: string;
};

export type TelegramUpdateClaimResult = {
	claimed: boolean;
	duplicate: boolean;
	record?: TelegramCoordinatorRecord;
};

export type DispatchLeaseInput = {
	providerSessionId: string;
	idempotencyKey: string;
	canonicalInputHash: string;
	sessionSequence?: number;
	generation?: string;
	updateId?: string;
	messageId?: string;
	providerTimestamp?: string;
	baselineLastHermesMessageId?: string;
	baselineLastHermesMessageTimestamp?: string;
};

export type TelegramCoordinatorDispatchResult =
	| { kind: "leased"; record: TelegramCoordinatorRecord }
	| { kind: "duplicate"; record?: TelegramCoordinatorRecord }
	| { kind: "deferred"; blocker?: TelegramCoordinatorRecord }
	| { kind: "recovery"; record: TelegramCoordinatorRecord };

export type TelegramCoordinatorTerminalInput = {
	providerSessionId: string;
	idempotencyKey: string;
	terminalReason?: string;
	replyContentHash?: string;
	recoveredAssistantMessageId?: string;
	recoveredAssistantContentHash?: string;
};

export type RetryPreReplyInput = {
	providerSessionId: string;
	idempotencyKey: string;
};

export type BeginReplyInput = {
	providerSessionId: string;
	idempotencyKey: string;
	replyContentHash: string;
	replyContent: string;
};

export type BeginReplyResult =
	| { kind: "ready"; record: TelegramCoordinatorRecord }
	| { kind: "duplicate"; record?: TelegramCoordinatorRecord }
	| { kind: "blocked"; record?: TelegramCoordinatorRecord };

type StoredRecordRow = {
	status: TelegramCoordinatorStatus;
	key: string;
	session_sequence: number;
	generation: string;
	update_id: string | null;
	message_id: string | null;
	provider_timestamp: string | null;
	provider_session_id: string;
	canonical_input_hash: string;
	baseline_last_hermes_message_id: string | null;
	baseline_last_hermes_message_timestamp: string | null;
	dispatch_timestamp: string | null;
	reply_timestamp: string | null;
	reply_content_hash: string | null;
	reply_content: string | null;
	attempt_count: number;
	recovered_assistant_message_id: string | null;
	recovered_assistant_content_hash: string | null;
	terminal_reason: string | null;
	expires_at: string;
};

type StoredSourceSelectionRow = {
	flow_id: string;
	user_id: string;
	question: string;
	message_id: number | null;
	phase: TelegramSourceSelection["phase"];
	repositories_json: string;
	repository: string | null;
	branches_json: string;
	expires_at: string;
};

type StoredCapabilityJobRow = {
	job_id: string;
	capability: string;
	status: CapabilityJobStatus;
	user_id: string;
	guild_id: string | null;
	channel_id: string | null;
	action_digest: string;
	objective: string;
	created_at: string;
	updated_at: string;
	expires_at: string;
	metadata_json: string;
};

type StoredCapabilityAuditRow = {
	sequence: number;
	timestamp: string;
	type: string;
	status: CapabilityJobStatus;
	detail: string | null;
	actor_user_id: string | null;
};

type StoredCapabilityApprovalRow = {
	approval_id: string;
	job_id: string;
	user_id: string;
	guild_id: string | null;
	action: string;
	action_digest: string;
	status: CapabilityApprovalStatus;
	created_at: string;
	expires_at: string;
	decided_at: string | null;
	decided_by_user_id: string | null;
};

const schemaVersion = 6;
const recordTtlMs = 86_400_000;
const defaultCapabilityJobTtlMs = 86_400_000;
const defaultCapabilityApprovalTtlMs = 900_000;

export class TelegramSessionCoordinator extends DurableObject<CoordinatorEnv> {
	constructor(ctx: DurableObjectState, env: CoordinatorEnv) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			this.migrate();
		});
	}

	async claim(
		input: TelegramUpdateClaimInput,
	): Promise<TelegramUpdateClaimResult> {
		const existing = this.findRecord(input.idempotencyKey);
		if (existing) {
			return { claimed: false, duplicate: true, record: existing };
		}
		const record: TelegramCoordinatorRecord = {
			version: 1,
			status: "claimed",
			key: input.idempotencyKey,
			sessionSequence: this.nextSequence(),
			generation: crypto.randomUUID(),
			...(input.updateId ? { updateId: input.updateId } : {}),
			...(input.messageId ? { messageId: input.messageId } : {}),
			...(input.providerTimestamp
				? { providerTimestamp: input.providerTimestamp }
				: {}),
			providerSessionId: input.providerSessionId,
			canonicalInputHash: input.canonicalInputHash,
			attemptCount: 0,
			expiresAt: new Date(Date.now() + recordTtlMs).toISOString(),
		};
		this.insertRecord(record);
		return { claimed: true, duplicate: false, record };
	}

	async dispatchLease(
		input: DispatchLeaseInput,
	): Promise<TelegramCoordinatorDispatchResult> {
		const record = this.findRecord(input.idempotencyKey);
		if (!record) {
			return { kind: "duplicate" };
		}
		if (!matchesRecord(record, input)) {
			return { kind: "duplicate", record };
		}
		if (record.status === "completed" || record.status === "failed") {
			return { kind: "duplicate", record };
		}
		if (record.status === "replying") {
			return { kind: "duplicate", record };
		}
		if (record.status === "dispatched") {
			return { kind: "recovery", record };
		}
		if (record.status === "uncertain") {
			return { kind: "duplicate", record };
		}
		const blocker = this.findEarlierActive(record.sessionSequence);
		if (blocker) {
			return { kind: "deferred", blocker };
		}
		const dispatchTimestamp = new Date().toISOString();
		this.ctx.storage.sql.exec(
			`UPDATE telegram_updates
			 SET status = 'dispatched',
			     baseline_last_hermes_message_id = ?,
			     baseline_last_hermes_message_timestamp = ?,
			     dispatch_timestamp = ?,
			     attempt_count = attempt_count + 1
			 WHERE key = ? AND status = 'claimed'`,
			input.baselineLastHermesMessageId ?? null,
			input.baselineLastHermesMessageTimestamp ?? null,
			dispatchTimestamp,
			input.idempotencyKey,
		);
		const leased = this.findRecord(input.idempotencyKey);
		return leased ? { kind: "leased", record: leased } : { kind: "duplicate" };
	}

	async beginReply(input: BeginReplyInput): Promise<BeginReplyResult> {
		const record = this.findRecord(input.idempotencyKey);
		if (!record) {
			return { kind: "duplicate" };
		}
		if (record.status === "replying") {
			return { kind: "duplicate", record };
		}
		if (record.status !== "claimed" && record.status !== "dispatched") {
			return { kind: "blocked", record };
		}
		this.ctx.storage.sql.exec(
			`UPDATE telegram_updates
			 SET status = 'replying',
			     reply_timestamp = ?,
			     reply_content_hash = ?,
			     reply_content = ?
			 WHERE key = ? AND status IN ('claimed', 'dispatched')`,
			new Date().toISOString(),
			input.replyContentHash,
			input.replyContent,
			input.idempotencyKey,
		);
		const replying = this.findRecord(input.idempotencyKey);
		return replying
			? { kind: "ready", record: replying }
			: { kind: "duplicate" };
	}

	async complete(input: TelegramCoordinatorTerminalInput): Promise<void> {
		this.terminal(input, "completed");
	}

	async fail(input: TelegramCoordinatorTerminalInput): Promise<void> {
		this.terminal(input, "failed");
	}

	async markUncertain(input: TelegramCoordinatorTerminalInput): Promise<void> {
		this.terminal(input, "uncertain");
	}

	async release(input: TelegramCoordinatorTerminalInput): Promise<void> {
		this.ctx.storage.sql.exec(
			"DELETE FROM telegram_updates WHERE key = ? AND status = 'claimed'",
			input.idempotencyKey,
		);
	}

	async retryPreReply(input: RetryPreReplyInput): Promise<void> {
		this.ctx.storage.sql.exec(
			`UPDATE telegram_updates
			 SET status = 'claimed',
			     baseline_last_hermes_message_id = NULL,
			     baseline_last_hermes_message_timestamp = NULL,
			     dispatch_timestamp = NULL
			 WHERE key = ?
			   AND provider_session_id = ?
			   AND status = 'dispatched'
			   AND reply_timestamp IS NULL
			   AND reply_content_hash IS NULL
			   AND reply_content IS NULL`,
			input.idempotencyKey,
			input.providerSessionId,
		);
	}

	async beginSourceSelection(
		input: BeginTelegramSourceSelectionInput,
	): Promise<TelegramSourceSelection> {
		const record = newSourceSelection(input);
		this.deleteExpiredSourceSelection();
		this.ctx.storage.sql.exec(
			`INSERT INTO telegram_source_selection (
				flow_id, user_id, question, message_id, phase, repositories_json,
				repository, branches_json, expires_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			record.flowId,
			record.userId,
			record.question,
			record.messageId ?? null,
			record.phase,
			JSON.stringify(record.repositories),
			null,
			"[]",
			record.expiresAt,
		);
		return record;
	}

	async getSourceSelection(
		input: TelegramSourceSelectionKey,
	): Promise<TelegramSourceSelection | undefined> {
		this.deleteExpiredSourceSelection();
		const record = this.findSourceSelection(input);
		return sourceSelectionMatches(record, input) ? record : undefined;
	}

	async getLatestSourceSelection(
		input: Omit<TelegramSourceSelectionKey, "flowId">,
	): Promise<TelegramSourceSelection | undefined> {
		this.deleteExpiredSourceSelection();
		const row = this.ctx.storage.sql
			.exec<StoredSourceSelectionRow>(
				`SELECT * FROM telegram_source_selection
				 WHERE user_id = ?
				 ORDER BY rowid DESC
				 LIMIT 1`,
				input.userId,
			)
			.toArray()[0];
		return row ? sourceSelectionRowToRecord(row) : undefined;
	}

	async setSourceRepository(
		input: SetTelegramSourceRepositoryInput,
	): Promise<TelegramSourceSelection | undefined> {
		const current = await this.getSourceSelection(input);
		if (!current || current.phase !== "repository") {
			return undefined;
		}
		this.ctx.storage.sql.exec(
			`UPDATE telegram_source_selection
			 SET phase = 'branch', repository = ?, branches_json = ?
			 WHERE flow_id = ? AND user_id = ?`,
			input.repository,
			JSON.stringify(input.branches),
			input.flowId,
			input.userId,
		);
		return this.getSourceSelection(input);
	}

	async waitForCustomBranch(
		input: TelegramSourceSelectionKey & { flowId: string },
	): Promise<TelegramSourceSelection | undefined> {
		const current = await this.getSourceSelection(input);
		if (!current || current.phase !== "branch") {
			return undefined;
		}
		this.ctx.storage.sql.exec(
			`UPDATE telegram_source_selection
			 SET phase = 'custom_branch'
			 WHERE flow_id = ? AND user_id = ?`,
			input.flowId,
			input.userId,
		);
		return this.getSourceSelection(input);
	}

	async consumeSourceSelection(
		input: TelegramSourceSelectionKey & { flowId: string },
	): Promise<TelegramSourceSelection | undefined> {
		const current = await this.getSourceSelection(input);
		if (!current) {
			return undefined;
		}
		this.ctx.storage.sql.exec(
			"DELETE FROM telegram_source_selection WHERE flow_id = ? AND user_id = ?",
			input.flowId,
			input.userId,
		);
		return current;
	}

	async clearSourceSelection(): Promise<void> {
		this.ctx.storage.sql.exec("DELETE FROM telegram_source_selection");
	}

	async createCapabilityJob(
		input: CreateCapabilityJobInput,
	): Promise<CapabilityJobRecord> {
		const now = input.now ?? new Date().toISOString();
		const jobId = input.jobId ?? crypto.randomUUID();
		const existing = this.findCapabilityJob(jobId);
		if (existing) {
			if (
				existing.capability !== input.capability ||
				existing.userId !== input.userId ||
				existing.actionDigest !== input.actionDigest
			) {
				throw new Error("capability job idempotency conflict");
			}
			return existing;
		}
		const expiresAt = new Date(
			Date.parse(now) +
				(input.ttlSeconds
					? input.ttlSeconds * 1000
					: defaultCapabilityJobTtlMs),
		).toISOString();
		this.ctx.storage.sql.exec(
			`INSERT INTO capability_jobs (
				job_id, capability, status, user_id, guild_id, channel_id,
				action_digest, objective, created_at, updated_at, expires_at,
				metadata_json
			) VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			jobId,
			input.capability,
			input.userId,
			input.guildId ?? null,
			input.channelId ?? null,
			input.actionDigest,
			input.objective,
			now,
			now,
			expiresAt,
			JSON.stringify(input.metadata ?? {}),
		);
		this.insertCapabilityAudit({
			jobId,
			timestamp: now,
			type: "created",
			status: "queued",
			actorUserId: input.userId,
		});
		const record = this.findCapabilityJob(jobId);
		if (!record) {
			throw new Error("capability job insert failed");
		}
		return record;
	}

	async getCapabilityJob(
		jobId: string,
	): Promise<CapabilityJobRecord | undefined> {
		return this.findCapabilityJob(jobId);
	}

	async transitionCapabilityJob(
		input: TransitionCapabilityJobInput,
	): Promise<CapabilityJobRecord | undefined> {
		const current = this.findCapabilityJob(input.jobId);
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
		this.ctx.storage.sql.exec(
			`UPDATE capability_jobs
			 SET status = ?, updated_at = ?
			 WHERE job_id = ?`,
			input.to,
			now,
			input.jobId,
		);
		this.insertCapabilityAudit({
			jobId: input.jobId,
			timestamp: now,
			type: "transition",
			status: input.to,
			detail: input.detail,
			actorUserId: input.actorUserId,
		});
		return this.findCapabilityJob(input.jobId);
	}

	async requestCapabilityApproval(
		input: RequestCapabilityApprovalInput,
	): Promise<CapabilityApprovalRecord> {
		const job = this.findCapabilityJob(input.jobId);
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
		const existing = this.findCapabilityApproval(approvalId);
		if (existing) {
			if (
				existing.jobId !== input.jobId ||
				existing.userId !== input.userId ||
				existing.actionDigest !== input.actionDigest
			) {
				throw new Error("capability approval idempotency conflict");
			}
			return this.expireCapabilityApproval(existing, input.now);
		}
		const now = input.now ?? new Date().toISOString();
		const expiresAt = new Date(
			Date.parse(now) +
				(input.ttlSeconds
					? input.ttlSeconds * 1000
					: defaultCapabilityApprovalTtlMs),
		).toISOString();
		this.ctx.storage.sql.exec(
			`INSERT INTO capability_approvals (
				approval_id, job_id, user_id, guild_id, action, action_digest,
				status, created_at, expires_at
			) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
			approvalId,
			input.jobId,
			input.userId,
			input.guildId ?? null,
			input.action,
			input.actionDigest,
			now,
			expiresAt,
		);
		await this.transitionCapabilityJob({
			jobId: input.jobId,
			from: ["queued", "running"],
			to: "waiting_approval",
			detail: `approval requested: ${input.action}`,
			actorUserId: input.userId,
			now,
		});
		const approval = this.findCapabilityApproval(approvalId);
		if (!approval) {
			throw new Error("capability approval insert failed");
		}
		return approval;
	}

	async getCapabilityApproval(
		approvalId: string,
	): Promise<CapabilityApprovalRecord | undefined> {
		const approval = this.findCapabilityApproval(approvalId);
		return approval ? this.expireCapabilityApproval(approval) : undefined;
	}

	async decideCapabilityApproval(
		input: DecideCapabilityApprovalInput,
	): Promise<CapabilityApprovalRecord | undefined> {
		const current = this.findCapabilityApproval(input.approvalId);
		if (!current) {
			return undefined;
		}
		const fresh = this.expireCapabilityApproval(current, input.now);
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
		this.ctx.storage.sql.exec(
			`UPDATE capability_approvals
			 SET status = ?, decided_at = ?, decided_by_user_id = ?
			 WHERE approval_id = ? AND status = 'pending'`,
			input.decision,
			now,
			input.userId,
			input.approvalId,
		);
		await this.transitionCapabilityJob({
			jobId: fresh.jobId,
			from: "waiting_approval",
			to: input.decision === "approved" ? "running" : "cancelled",
			detail: `approval ${input.decision}`,
			actorUserId: input.userId,
			now,
		});
		return this.findCapabilityApproval(input.approvalId);
	}

	private terminal(
		input: TelegramCoordinatorTerminalInput,
		status: "completed" | "failed" | "uncertain",
	): void {
		this.ctx.storage.sql.exec(
			`UPDATE telegram_updates
			 SET status = ?,
			     terminal_reason = ?,
			     reply_content_hash = COALESCE(reply_content_hash, ?),
			     recovered_assistant_message_id = ?,
			     recovered_assistant_content_hash = ?
			 WHERE key = ?`,
			status,
			input.terminalReason ?? null,
			input.replyContentHash ?? null,
			input.recoveredAssistantMessageId ?? null,
			input.recoveredAssistantContentHash ?? null,
			input.idempotencyKey,
		);
	}

	private migrate(): void {
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
				id INTEGER PRIMARY KEY,
				applied_at TEXT NOT NULL DEFAULT (datetime('now'))
			)
		`);
		const currentVersion = this.ctx.storage.sql
			.exec<{ version: number }>(
				"SELECT COALESCE(MAX(id), 0) as version FROM _sql_schema_migrations",
			)
			.one().version;
		if (currentVersion > schemaVersion) {
			throw new Error(
				`Telegram coordinator schema version ${currentVersion} is newer than supported version ${schemaVersion}`,
			);
		}
		if (currentVersion < 1) {
			this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS telegram_updates (
				key TEXT PRIMARY KEY,
				status TEXT NOT NULL,
				session_sequence INTEGER NOT NULL,
				generation TEXT NOT NULL,
				update_id TEXT,
				message_id TEXT,
				provider_timestamp TEXT,
				provider_session_id TEXT NOT NULL,
				canonical_input_hash TEXT NOT NULL,
				baseline_last_hermes_message_id TEXT,
				baseline_last_hermes_message_timestamp TEXT,
				dispatch_timestamp TEXT,
				attempt_count INTEGER NOT NULL,
				recovered_assistant_message_id TEXT,
				recovered_assistant_content_hash TEXT,
				terminal_reason TEXT,
				expires_at TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_telegram_updates_sequence
				ON telegram_updates(session_sequence);
			CREATE INDEX IF NOT EXISTS idx_telegram_updates_status
				ON telegram_updates(status);
			INSERT INTO _sql_schema_migrations (id) VALUES (1);
		`);
		}
		if (currentVersion < 2) {
			this.ctx.storage.sql.exec(`
				ALTER TABLE telegram_updates ADD COLUMN reply_timestamp TEXT;
				ALTER TABLE telegram_updates ADD COLUMN reply_content_hash TEXT;
				INSERT INTO _sql_schema_migrations (id) VALUES (2);
			`);
		}
		if (currentVersion < 3) {
			this.ctx.storage.sql.exec(`
				ALTER TABLE telegram_updates ADD COLUMN reply_content TEXT;
				INSERT INTO _sql_schema_migrations (id) VALUES (3);
			`);
		}
		if (currentVersion < 4) {
			this.ctx.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS telegram_source_selection (
					singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
					flow_id TEXT NOT NULL,
					user_id TEXT NOT NULL,
					question TEXT NOT NULL,
					message_id INTEGER,
					phase TEXT NOT NULL,
					repository TEXT,
					branches_json TEXT NOT NULL,
					expires_at TEXT NOT NULL
				);
				INSERT INTO _sql_schema_migrations (id) VALUES (4);
			`);
		}
		if (currentVersion < 5) {
			this.ctx.storage.sql.exec(`
				CREATE TABLE telegram_source_selection_v5 (
					flow_id TEXT PRIMARY KEY,
					user_id TEXT NOT NULL,
					question TEXT NOT NULL,
					message_id INTEGER,
					phase TEXT NOT NULL,
					repositories_json TEXT NOT NULL,
					repository TEXT,
					branches_json TEXT NOT NULL,
					expires_at TEXT NOT NULL
				);
				INSERT INTO telegram_source_selection_v5 (
					flow_id, user_id, question, message_id, phase,
					repositories_json, repository, branches_json, expires_at
				)
				SELECT flow_id, user_id, question, message_id, phase,
					'[]', repository, branches_json, expires_at
				FROM telegram_source_selection;
				DROP TABLE telegram_source_selection;
				ALTER TABLE telegram_source_selection_v5
					RENAME TO telegram_source_selection;
				CREATE INDEX idx_telegram_source_selection_user
					ON telegram_source_selection(user_id, expires_at);
				INSERT INTO _sql_schema_migrations (id) VALUES (5);
			`);
		}
		if (currentVersion < 6) {
			this.ctx.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS capability_jobs (
					job_id TEXT PRIMARY KEY,
					capability TEXT NOT NULL,
					status TEXT NOT NULL,
					user_id TEXT NOT NULL,
					guild_id TEXT,
					channel_id TEXT,
					action_digest TEXT NOT NULL,
					objective TEXT NOT NULL,
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL,
					expires_at TEXT NOT NULL,
					metadata_json TEXT NOT NULL
				);
				CREATE INDEX IF NOT EXISTS idx_capability_jobs_status
					ON capability_jobs(status, expires_at);
				CREATE TABLE IF NOT EXISTS capability_job_audit (
					job_id TEXT NOT NULL,
					sequence INTEGER NOT NULL,
					timestamp TEXT NOT NULL,
					type TEXT NOT NULL,
					status TEXT NOT NULL,
					detail TEXT,
					actor_user_id TEXT,
					PRIMARY KEY (job_id, sequence)
				);
				CREATE TABLE IF NOT EXISTS capability_approvals (
					approval_id TEXT PRIMARY KEY,
					job_id TEXT NOT NULL,
					user_id TEXT NOT NULL,
					guild_id TEXT,
					action TEXT NOT NULL,
					action_digest TEXT NOT NULL,
					status TEXT NOT NULL,
					created_at TEXT NOT NULL,
					expires_at TEXT NOT NULL,
					decided_at TEXT,
					decided_by_user_id TEXT
				);
				CREATE INDEX IF NOT EXISTS idx_capability_approvals_job
					ON capability_approvals(job_id, status);
				INSERT INTO _sql_schema_migrations (id) VALUES (6);
			`);
		}
	}

	private deleteExpiredSourceSelection(): void {
		this.ctx.storage.sql.exec(
			"DELETE FROM telegram_source_selection WHERE expires_at <= ?",
			new Date().toISOString(),
		);
	}

	private findSourceSelection(
		input: TelegramSourceSelectionKey,
	): TelegramSourceSelection | undefined {
		const row = input.flowId
			? this.ctx.storage.sql
					.exec<StoredSourceSelectionRow>(
						`SELECT * FROM telegram_source_selection
						 WHERE flow_id = ? AND user_id = ?
						 LIMIT 1`,
						input.flowId,
						input.userId,
					)
					.toArray()[0]
			: this.ctx.storage.sql
					.exec<StoredSourceSelectionRow>(
						`SELECT * FROM telegram_source_selection
						 WHERE user_id = ? AND phase = 'custom_branch'
						 ORDER BY rowid DESC
						 LIMIT 1`,
						input.userId,
					)
					.toArray()[0];
		return row ? sourceSelectionRowToRecord(row) : undefined;
	}

	private nextSequence(): number {
		return this.ctx.storage.sql
			.exec<{ sequence: number }>(
				"SELECT COALESCE(MAX(session_sequence), 0) + 1 as sequence FROM telegram_updates",
			)
			.one().sequence;
	}

	private findRecord(key: string): TelegramCoordinatorRecord | undefined {
		const row = this.ctx.storage.sql
			.exec<StoredRecordRow>(
				"SELECT * FROM telegram_updates WHERE key = ?",
				key,
			)
			.toArray()[0];
		return row ? rowToRecord(row) : undefined;
	}

	private findEarlierActive(
		sessionSequence: number,
	): TelegramCoordinatorRecord | undefined {
		const row = this.ctx.storage.sql
			.exec<StoredRecordRow>(
				`SELECT * FROM telegram_updates
				 WHERE session_sequence < ?
				   AND status IN ('claimed', 'dispatched', 'replying')
				 ORDER BY session_sequence ASC
				 LIMIT 1`,
				sessionSequence,
			)
			.toArray()[0];
		return row ? rowToRecord(row) : undefined;
	}

	private insertRecord(record: TelegramCoordinatorRecord): void {
		this.ctx.storage.sql.exec(
			`INSERT INTO telegram_updates (
				key, status, session_sequence, generation, update_id, message_id,
				provider_timestamp, provider_session_id, canonical_input_hash,
				baseline_last_hermes_message_id, baseline_last_hermes_message_timestamp,
				dispatch_timestamp, reply_timestamp, reply_content_hash,
				reply_content, attempt_count, recovered_assistant_message_id,
				recovered_assistant_content_hash, terminal_reason, expires_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			record.key,
			record.status,
			record.sessionSequence,
			record.generation,
			record.updateId ?? null,
			record.messageId ?? null,
			record.providerTimestamp ?? null,
			record.providerSessionId,
			record.canonicalInputHash,
			record.baselineLastHermesMessageId ?? null,
			record.baselineLastHermesMessageTimestamp ?? null,
			record.dispatchTimestamp ?? null,
			record.replyTimestamp ?? null,
			record.replyContentHash ?? null,
			record.replyContent ?? null,
			record.attemptCount,
			record.recoveredAssistantMessageId ?? null,
			record.recoveredAssistantContentHash ?? null,
			record.terminalReason ?? null,
			record.expiresAt,
		);
	}

	private findCapabilityJob(jobId: string): CapabilityJobRecord | undefined {
		const row = this.ctx.storage.sql
			.exec<StoredCapabilityJobRow>(
				"SELECT * FROM capability_jobs WHERE job_id = ?",
				jobId,
			)
			.toArray()[0];
		if (!row) {
			return undefined;
		}
		const audit = this.ctx.storage.sql
			.exec<StoredCapabilityAuditRow>(
				`SELECT * FROM capability_job_audit
				 WHERE job_id = ?
				 ORDER BY sequence ASC`,
				jobId,
			)
			.toArray();
		return capabilityJobRowToRecord(row, audit);
	}

	private insertCapabilityAudit(input: {
		jobId: string;
		timestamp: string;
		type: string;
		status: CapabilityJobStatus;
		detail?: string;
		actorUserId?: string;
	}): void {
		const sequence = this.ctx.storage.sql
			.exec<{ sequence: number }>(
				`SELECT COALESCE(MAX(sequence), 0) + 1 as sequence
				 FROM capability_job_audit
				 WHERE job_id = ?`,
				input.jobId,
			)
			.one().sequence;
		this.ctx.storage.sql.exec(
			`INSERT INTO capability_job_audit (
				job_id, sequence, timestamp, type, status, detail, actor_user_id
			) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			input.jobId,
			sequence,
			input.timestamp,
			input.type,
			input.status,
			input.detail ?? null,
			input.actorUserId ?? null,
		);
	}

	private findCapabilityApproval(
		approvalId: string,
	): CapabilityApprovalRecord | undefined {
		const row = this.ctx.storage.sql
			.exec<StoredCapabilityApprovalRow>(
				"SELECT * FROM capability_approvals WHERE approval_id = ?",
				approvalId,
			)
			.toArray()[0];
		return row ? capabilityApprovalRowToRecord(row) : undefined;
	}

	private expireCapabilityApproval(
		record: CapabilityApprovalRecord,
		now = new Date().toISOString(),
	): CapabilityApprovalRecord {
		if (
			record.status !== "pending" ||
			Date.parse(record.expiresAt) > Date.parse(now)
		) {
			return record;
		}
		this.ctx.storage.sql.exec(
			`UPDATE capability_approvals
			 SET status = 'expired', decided_at = ?
			 WHERE approval_id = ? AND status = 'pending'`,
			now,
			record.approvalId,
		);
		return this.findCapabilityApproval(record.approvalId) ?? record;
	}
}

function sourceSelectionMatches(
	record: TelegramSourceSelection | undefined,
	input: TelegramSourceSelectionKey,
): boolean {
	return Boolean(
		record &&
			record.userId === input.userId &&
			(input.flowId === undefined || record.flowId === input.flowId),
	);
}

function sourceSelectionRowToRecord(
	row: StoredSourceSelectionRow,
): TelegramSourceSelection {
	const repositories = parseStringArray(row.repositories_json);
	const branches = parseStringArray(row.branches_json);
	return {
		flowId: row.flow_id,
		userId: row.user_id,
		question: row.question,
		...(row.message_id !== null ? { messageId: row.message_id } : {}),
		phase: row.phase,
		repositories,
		...(row.repository ? { repository: row.repository } : {}),
		branches,
		expiresAt: row.expires_at,
	};
}

function parseStringArray(serialized: string): string[] {
	let branches: string[] = [];
	try {
		const parsed = JSON.parse(serialized);
		branches = Array.isArray(parsed)
			? parsed.filter((value): value is string => typeof value === "string")
			: [];
	} catch {
		branches = [];
	}
	return branches;
}

function matchesRecord(
	record: TelegramCoordinatorRecord,
	input: DispatchLeaseInput,
): boolean {
	return (
		record.providerSessionId === input.providerSessionId &&
		record.canonicalInputHash === input.canonicalInputHash &&
		(input.sessionSequence === undefined ||
			record.sessionSequence === input.sessionSequence) &&
		(input.generation === undefined || record.generation === input.generation)
	);
}

function rowToRecord(row: StoredRecordRow): TelegramCoordinatorRecord {
	return {
		version: 1,
		status: row.status,
		key: row.key,
		sessionSequence: row.session_sequence,
		generation: row.generation,
		...(row.update_id ? { updateId: row.update_id } : {}),
		...(row.message_id ? { messageId: row.message_id } : {}),
		...(row.provider_timestamp
			? { providerTimestamp: row.provider_timestamp }
			: {}),
		providerSessionId: row.provider_session_id,
		canonicalInputHash: row.canonical_input_hash,
		...(row.baseline_last_hermes_message_id
			? { baselineLastHermesMessageId: row.baseline_last_hermes_message_id }
			: {}),
		...(row.baseline_last_hermes_message_timestamp
			? {
					baselineLastHermesMessageTimestamp:
						row.baseline_last_hermes_message_timestamp,
				}
			: {}),
		...(row.dispatch_timestamp
			? { dispatchTimestamp: row.dispatch_timestamp }
			: {}),
		...(row.reply_timestamp ? { replyTimestamp: row.reply_timestamp } : {}),
		...(row.reply_content_hash
			? { replyContentHash: row.reply_content_hash }
			: {}),
		...(row.reply_content ? { replyContent: row.reply_content } : {}),
		attemptCount: row.attempt_count,
		...(row.recovered_assistant_message_id
			? { recoveredAssistantMessageId: row.recovered_assistant_message_id }
			: {}),
		...(row.recovered_assistant_content_hash
			? { recoveredAssistantContentHash: row.recovered_assistant_content_hash }
			: {}),
		...(row.terminal_reason ? { terminalReason: row.terminal_reason } : {}),
		expiresAt: row.expires_at,
	};
}

function capabilityJobRowToRecord(
	row: StoredCapabilityJobRow,
	auditRows: readonly StoredCapabilityAuditRow[],
): CapabilityJobRecord {
	return {
		jobId: row.job_id,
		capability: row.capability,
		status: row.status,
		userId: row.user_id,
		...(row.guild_id ? { guildId: row.guild_id } : {}),
		...(row.channel_id ? { channelId: row.channel_id } : {}),
		actionDigest: row.action_digest,
		objective: row.objective,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		expiresAt: row.expires_at,
		metadata: parseStringRecord(row.metadata_json),
		audit: auditRows.map((audit) => ({
			sequence: audit.sequence,
			timestamp: audit.timestamp,
			type: audit.type,
			status: audit.status,
			...(audit.detail ? { detail: audit.detail } : {}),
			...(audit.actor_user_id ? { actorUserId: audit.actor_user_id } : {}),
		})),
	};
}

function capabilityApprovalRowToRecord(
	row: StoredCapabilityApprovalRow,
): CapabilityApprovalRecord {
	return {
		approvalId: row.approval_id,
		jobId: row.job_id,
		userId: row.user_id,
		...(row.guild_id ? { guildId: row.guild_id } : {}),
		action: row.action,
		actionDigest: row.action_digest,
		status: row.status,
		createdAt: row.created_at,
		expiresAt: row.expires_at,
		...(row.decided_at ? { decidedAt: row.decided_at } : {}),
		...(row.decided_by_user_id
			? { decidedByUserId: row.decided_by_user_id }
			: {}),
	};
}

function parseStringRecord(serialized: string): Record<string, string> {
	try {
		const parsed = JSON.parse(serialized);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return {};
		}
		return Object.fromEntries(
			Object.entries(parsed).filter(
				(entry): entry is [string, string] => typeof entry[1] === "string",
			),
		);
	} catch {
		return {};
	}
}
