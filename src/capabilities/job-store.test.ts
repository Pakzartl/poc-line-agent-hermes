import { describe, expect, test } from "bun:test";
import {
	createMemoryCapabilityJobStore,
	isValidTransition,
	type CapabilityJobRecord,
} from "./job-store";

const createdAt = "2099-10-04T10:00:00.000Z";

describe("capability job store", () => {
	test("creates idempotent jobs with immutable audit entries", async () => {
		const store = createMemoryCapabilityJobStore();
		const first = await store.createJob(jobInput());
		const duplicate = await store.createJob(jobInput());

		expect(duplicate).toEqual(first);
		expect(first).toMatchObject({
			jobId: "job-1",
			status: "queued",
			capability: "risk-assessment",
			actionDigest: "digest-1",
		});
		expect(first.audit).toEqual([
			{
				sequence: 1,
				timestamp: createdAt,
				type: "created",
				status: "queued",
				actorUserId: "9001",
			},
		]);
	});

	test("validates lifecycle transitions idempotently", async () => {
		const store = createMemoryCapabilityJobStore();
		await store.createJob(jobInput());

		const running = await store.transitionJob({
			jobId: "job-1",
			from: "queued",
			to: "running",
			now: "2099-10-04T10:01:00.000Z",
		});
		const duplicate = await store.transitionJob({
			jobId: "job-1",
			from: "queued",
			to: "running",
		});

		expect(running?.status).toBe("running");
		expect(duplicate?.status).toBe("running");
		expect(duplicate?.audit).toHaveLength(2);
		await expect(
			store.transitionJob({ jobId: "job-1", to: "queued" }),
		).rejects.toThrow("invalid capability job transition running -> queued");
	});

	test("binds approval decisions to job user guild and action digest", async () => {
		const store = createMemoryCapabilityJobStore();
		await store.createJob(jobInput({ guildId: "guild-1" }));
		await store.transitionJob({ jobId: "job-1", to: "running" });
		const approval = await store.requestApproval({
			approvalId: "approval-1",
			jobId: "job-1",
			userId: "9001",
			guildId: "guild-1",
			action: "deploy worker version abc",
			actionDigest: "digest-1",
			now: "2099-10-04T10:02:00.000Z",
		});

		expect(approval.status).toBe("pending");
		expect((await store.getJob("job-1"))?.status).toBe("waiting_approval");
		await expect(
			store.decideApproval({
				approvalId: "approval-1",
				decision: "approved",
				userId: "9002",
				guildId: "guild-1",
				actionDigest: "digest-1",
			}),
		).rejects.toThrow("capability approval decision binding conflict");

		const approved = await store.decideApproval({
			approvalId: "approval-1",
			decision: "approved",
			userId: "9001",
			guildId: "guild-1",
			actionDigest: "digest-1",
			now: "2099-10-04T10:03:00.000Z",
		});
		const secondDecision = await store.decideApproval({
			approvalId: "approval-1",
			decision: "rejected",
			userId: "9001",
			guildId: "guild-1",
			actionDigest: "digest-1",
		});

		expect(approved?.status).toBe("approved");
		expect(secondDecision?.status).toBe("approved");
		expect((await store.getJob("job-1"))?.status).toBe("running");
	});

	test("expires pending approvals without approving the job", async () => {
		const store = createMemoryCapabilityJobStore();
		await store.createJob(jobInput());
		await store.transitionJob({ jobId: "job-1", to: "running" });
		await store.requestApproval({
			approvalId: "approval-1",
			jobId: "job-1",
			userId: "9001",
			action: "deploy worker version abc",
			actionDigest: "digest-1",
			ttlSeconds: 1,
			now: "2099-10-04T10:00:00.000Z",
		});

		expect(await store.getApproval("approval-1")).toEqual(
			expect.objectContaining({ status: "pending" }),
		);
		expect(
			await store.decideApproval({
				approvalId: "approval-1",
				decision: "approved",
				userId: "9001",
				actionDigest: "digest-1",
				now: "2099-10-04T10:00:02.000Z",
			}),
		).toEqual(expect.objectContaining({ status: "expired" }));
		expect((await store.getJob("job-1"))?.status).toBe("waiting_approval");
	});

	test("documents the allowed lifecycle graph", () => {
		expect(isValidTransition("queued", "running")).toBe(true);
		expect(isValidTransition("running", "waiting_approval")).toBe(true);
		expect(isValidTransition("waiting_approval", "running")).toBe(true);
		expect(isValidTransition("completed", "running")).toBe(false);
	});
});

function jobInput(overrides: Partial<CapabilityJobRecord> = {}) {
	return {
		jobId: overrides.jobId ?? "job-1",
		capability: overrides.capability ?? "risk-assessment",
		userId: overrides.userId ?? "9001",
		guildId: overrides.guildId,
		channelId: overrides.channelId,
		actionDigest: overrides.actionDigest ?? "digest-1",
		objective: overrides.objective ?? "review checkout deploy risk",
		now: createdAt,
		metadata: { repository: "codemonday-dev/lms-backend" },
	};
}
