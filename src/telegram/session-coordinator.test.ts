import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createDurableObjectTelegramUpdateStore } from "./update-store";
import type {
	DispatchLeaseInput,
	TelegramSessionCoordinator,
	TelegramUpdateClaimInput,
} from "./session-coordinator";

mock.module("cloudflare:workers", () => ({
	DurableObject: class DurableObject {
		protected ctx: DurableObjectState;
		protected env: Record<string, unknown>;

		constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
			this.ctx = ctx;
			this.env = env;
		}
	},
}));

type SqlValue = string | number | null;
type SqlResult<T> = {
	toArray(): T[];
	one(): T;
};

type Harness = {
	coordinator: TelegramSessionCoordinator;
	db: Database;
	tmpPath?: string;
};

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) {
			rmSync(dir, { recursive: true, force: true });
		}
	}
});

describe("TelegramSessionCoordinator durable object", () => {
	test("allows only one concurrent duplicate claim", async () => {
		const { coordinator } = await createHarness();
		const claims = await Promise.all(
			Array.from({ length: 10 }, () => coordinator.claim(claimInput("a", 1))),
		);

		expect(claims.filter((claim) => claim.claimed)).toHaveLength(1);
		expect(claims.filter((claim) => claim.duplicate)).toHaveLength(9);
	});

	test("assigns monotonic session sequences and defers B before A terminalizes", async () => {
		const { coordinator } = await createHarness();
		const a = await coordinator.claim(claimInput("a", 1));
		const b = await coordinator.claim(claimInput("b", 2));

		expect(a.record?.sessionSequence).toBe(1);
		expect(b.record?.sessionSequence).toBe(2);
		expect(
			await coordinator.dispatchLease(dispatchInput("b", b.record)),
		).toEqual(expect.objectContaining({ kind: "deferred" }));
	});

	test("issues one dispatch lease and treats duplicate dispatch as recovery-only", async () => {
		const { coordinator } = await createHarness();
		const claim = await coordinator.claim(claimInput("a", 1));
		const input = dispatchInput("a", claim.record);
		const dispatches = await Promise.all([
			coordinator.dispatchLease(input),
			coordinator.dispatchLease(input),
		]);

		expect(
			dispatches.filter((dispatch) => dispatch.kind === "leased"),
		).toHaveLength(1);
		expect(
			dispatches.filter((dispatch) => dispatch.kind === "recovery"),
		).toHaveLength(1);
	});

	test("keeps different chat coordinators independent", async () => {
		const first = await createHarness();
		const second = await createHarness();
		const firstClaim = await first.coordinator.claim(
			claimInput("a", 1, "chat:1"),
		);
		const secondClaim = await second.coordinator.claim(
			claimInput("b", 1, "chat:2"),
		);

		expect(firstClaim.record?.sessionSequence).toBe(1);
		expect(secondClaim.record?.sessionSequence).toBe(1);
	});

	test("preserves dispatched records across restart and returns recovery-only", async () => {
		const dir = mkdtempSync(join(tmpdir(), "telegram-do-"));
		tempDirs.push(dir);
		const file = join(dir, "state.sqlite");
		const first = await createHarness(file);
		const claim = await first.coordinator.claim(claimInput("a", 1));
		const input = dispatchInput("a", claim.record);
		expect(await first.coordinator.dispatchLease(input)).toEqual(
			expect.objectContaining({ kind: "leased" }),
		);
		first.db.close();

		const restarted = await createHarness(file);
		expect(await restarted.coordinator.dispatchLease(input)).toEqual(
			expect.objectContaining({ kind: "recovery" }),
		);
	});

	test("replying state prevents a second reply or lease", async () => {
		const { coordinator } = await createHarness();
		const claim = await coordinator.claim(claimInput("a", 1));
		const input = dispatchInput("a", claim.record);
		await coordinator.dispatchLease(input);

		expect(
			await coordinator.beginReply({
				providerSessionId: "telegram:chat:1",
				idempotencyKey: "telegram:update:a",
				replyContentHash: "reply",
				replyContent: "recovered answer",
			}),
		).toEqual(expect.objectContaining({ kind: "ready" }));
		expect(await coordinator.dispatchLease(input)).toEqual(
			expect.objectContaining({
				kind: "duplicate",
				record: expect.objectContaining({
					status: "replying",
					replyContent: "recovered answer",
				}),
			}),
		);
		expect(
			await coordinator.beginReply({
				providerSessionId: "telegram:chat:1",
				idempotencyKey: "telegram:update:a",
				replyContentHash: "reply",
				replyContent: "recovered answer",
			}),
		).toEqual(expect.objectContaining({ kind: "duplicate" }));
	});

	test("terminal and uncertain states do not block later read-only work", async () => {
		const { coordinator } = await createHarness();
		const a = await coordinator.claim(claimInput("a", 1));
		await coordinator.dispatchLease(dispatchInput("a", a.record));
		await coordinator.complete({
			providerSessionId: "telegram:chat:1",
			idempotencyKey: "telegram:update:a",
		});
		const b = await coordinator.claim(claimInput("b", 2));
		expect(
			await coordinator.dispatchLease(dispatchInput("b", b.record)),
		).toEqual(expect.objectContaining({ kind: "leased" }));
		await coordinator.markUncertain({
			providerSessionId: "telegram:chat:1",
			idempotencyKey: "telegram:update:b",
		});
		const c = await coordinator.claim(claimInput("c", 3));
		expect(
			await coordinator.dispatchLease(dispatchInput("c", c.record)),
		).toEqual(expect.objectContaining({ kind: "leased" }));
	});

	test("durable-object facade propagates unhealthy coordinator errors", async () => {
		const store = createDurableObjectTelegramUpdateStore({
			getByName() {
				throw new Error("DO unavailable");
			},
		});

		expect(() => store.claim(claimInput("a", 1))).toThrow("DO unavailable");
	});

	test("persists and consumes one source-selection flow per chat", async () => {
		const { coordinator } = await createHarness();
		const selection = await coordinator.beginSourceSelection({
			providerSessionId: "telegram:chat:1",
			userId: "9001",
			question: "find the rate limit",
			repositories: ["codemonday-dev/lms-backend"],
			messageId: 42,
		});
		const withRepository = await coordinator.setSourceRepository({
			providerSessionId: "telegram:chat:1",
			userId: "9001",
			flowId: selection.flowId,
			repository: "codemonday-dev/lms-backend",
			branches: ["dev", "main"],
		});

		expect(withRepository).toEqual(
			expect.objectContaining({
				phase: "branch",
				repository: "codemonday-dev/lms-backend",
				branches: ["dev", "main"],
			}),
		);
		expect(
			await coordinator.consumeSourceSelection({
				providerSessionId: "telegram:chat:1",
				userId: "9001",
				flowId: selection.flowId,
			}),
		).toEqual(expect.objectContaining({ question: "find the rate limit" }));
		expect(
			await coordinator.getSourceSelection({
				providerSessionId: "telegram:chat:1",
				userId: "9001",
			}),
		).toBeUndefined();
	});

	test("keeps overlapping source-selection flows independently addressable", async () => {
		const { coordinator } = await createHarness();
		const first = await coordinator.beginSourceSelection({
			providerSessionId: "telegram:chat:source-v4:9001",
			userId: "9001",
			question: "first question",
			repositories: ["example/first"],
		});
		const second = await coordinator.beginSourceSelection({
			providerSessionId: "telegram:chat:source-v4:9001",
			userId: "9001",
			question: "second question",
			repositories: ["example/second"],
		});

		expect(
			await coordinator.getSourceSelection({
				providerSessionId: "telegram:chat:source-v4:9001",
				userId: "9001",
				flowId: first.flowId,
			}),
		).toEqual(expect.objectContaining({ question: "first question" }));
		expect(
			await coordinator.getSourceSelection({
				providerSessionId: "telegram:chat:source-v4:9001",
				userId: "9001",
				flowId: second.flowId,
			}),
		).toEqual(expect.objectContaining({ question: "second question" }));
	});

	test("migrates the singleton source picker to independent version-five flows", async () => {
		const dir = mkdtempSync(join(tmpdir(), "telegram-do-v4-"));
		tempDirs.push(dir);
		const file = join(dir, "state.sqlite");
		const legacyDb = new Database(file);
		legacyDb.exec(`
			CREATE TABLE _sql_schema_migrations (id INTEGER PRIMARY KEY);
			INSERT INTO _sql_schema_migrations (id) VALUES (1), (2), (3), (4);
			CREATE TABLE telegram_source_selection (
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
		`);
		legacyDb
			.query(
				`INSERT INTO telegram_source_selection (
					singleton, flow_id, user_id, question, message_id, phase,
					repository, branches_json, expires_at
				) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				"00000000-0000-4000-8000-000000000001",
				"9001",
				"legacy question",
				42,
				"repository",
				null,
				"[]",
				new Date(Date.now() + 60_000).toISOString(),
			);
		legacyDb.close();

		const { coordinator } = await createHarness(file);
		expect(
			await coordinator.getSourceSelection({
				providerSessionId: "telegram:chat:source-v4:9001",
				userId: "9001",
				flowId: "00000000-0000-4000-8000-000000000001",
			}),
		).toEqual(
			expect.objectContaining({
				question: "legacy question",
				repositories: [],
			}),
		);
		const current = await coordinator.beginSourceSelection({
			providerSessionId: "telegram:chat:source-v4:9001",
			userId: "9001",
			question: "current question",
			repositories: ["example/current"],
		});
		expect(
			await coordinator.getSourceSelection({
				providerSessionId: "telegram:chat:source-v4:9001",
				userId: "9001",
				flowId: current.flowId,
			}),
		).toEqual(expect.objectContaining({ question: "current question" }));
	});

	test("persists capability job approvals across restart", async () => {
		const dir = mkdtempSync(join(tmpdir(), "capability-do-"));
		tempDirs.push(dir);
		const file = join(dir, "state.sqlite");
		const first = await createHarness(file);
		await first.coordinator.createCapabilityJob({
			jobId: "job-1",
			capability: "deploy",
			userId: "9001",
			guildId: "guild-1",
			actionDigest: "digest-1",
			objective: "deploy worker version abc",
			now: "2099-10-04T10:00:00.000Z",
		});
		await first.coordinator.transitionCapabilityJob({
			jobId: "job-1",
			to: "running",
			now: "2099-10-04T10:01:00.000Z",
		});
		await first.coordinator.requestCapabilityApproval({
			approvalId: "approval-1",
			jobId: "job-1",
			userId: "9001",
			guildId: "guild-1",
			action: "deploy worker version abc",
			actionDigest: "digest-1",
			now: "2099-10-04T10:02:00.000Z",
		});
		first.db.close();

		const restarted = await createHarness(file);
		expect(await restarted.coordinator.getCapabilityJob("job-1")).toEqual(
			expect.objectContaining({
				status: "waiting_approval",
				audit: expect.arrayContaining([
					expect.objectContaining({ status: "queued" }),
					expect.objectContaining({ status: "running" }),
					expect.objectContaining({ status: "waiting_approval" }),
				]),
			}),
		);
		expect(
			await restarted.coordinator.decideCapabilityApproval({
				approvalId: "approval-1",
				decision: "approved",
				userId: "9001",
				guildId: "guild-1",
				actionDigest: "digest-1",
				now: "2099-10-04T10:03:00.000Z",
			}),
		).toEqual(expect.objectContaining({ status: "approved" }));
		expect(
			await restarted.coordinator.decideCapabilityApproval({
				approvalId: "approval-1",
				decision: "rejected",
				userId: "9001",
				guildId: "guild-1",
				actionDigest: "digest-1",
			}),
		).toEqual(expect.objectContaining({ status: "approved" }));
	});
});

async function createHarness(file = ":memory:"): Promise<Harness> {
	const [{ TelegramSessionCoordinator }] = await Promise.all([
		import("./session-coordinator"),
	]);
	const db = new Database(file);
	const sql = new SqlStorage(db);
	const ctx = {
		storage: { sql },
		blockConcurrencyWhile(callback: () => Promise<void>) {
			void callback();
		},
	} as unknown as DurableObjectState;
	return {
		coordinator: new TelegramSessionCoordinator(ctx, {}),
		db,
		tmpPath: file === ":memory:" ? undefined : file,
	};
}

class SqlStorage {
	constructor(private readonly db: Database) {}

	exec<T>(sql: string, ...params: SqlValue[]): SqlResult<T> {
		const trimmed = sql.trim();
		if (params.length === 0 && trimmed.includes(";")) {
			this.db.exec(trimmed);
			return emptyResult<T>();
		}
		if (/^(SELECT|PRAGMA)\b/i.test(trimmed)) {
			const statement = this.db.query(trimmed);
			return {
				toArray: () => statement.all(...params) as T[],
				one: () => {
					const row = statement.get(...params) as T | null;
					if (!row) {
						throw new Error("Expected one SQL row");
					}
					return row;
				},
			};
		}
		this.db.query(trimmed).run(...params);
		return emptyResult<T>();
	}
}

function emptyResult<T>(): SqlResult<T> {
	return {
		toArray: () => [],
		one: () => {
			throw new Error("Expected one SQL row");
		},
	};
}

function claimInput(
	id: string,
	messageId: number,
	providerSessionId = "telegram:chat:1",
): TelegramUpdateClaimInput {
	return {
		providerSessionId,
		idempotencyKey: `telegram:update:${id}`,
		canonicalInputHash: `hash:${id}`,
		updateId: id,
		messageId: String(messageId),
	};
}

function dispatchInput(
	id: string,
	record: { sessionSequence?: number; generation?: string } | undefined,
): DispatchLeaseInput {
	return {
		providerSessionId: "telegram:chat:1",
		idempotencyKey: `telegram:update:${id}`,
		canonicalInputHash: `hash:${id}`,
		sessionSequence: record?.sessionSequence,
		generation: record?.generation,
	};
}
