import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDeployExecutorConfig } from "./config";
import {
	type CommandRunner,
	type DeployRequest,
	deployWithIdempotency,
} from "./deployer";
import { createDeployExecutorHandler } from "./server";

const repo = "https://github.com/Pakzartl/poc-line-agent-hermes.git";
const sha = "a".repeat(40);
const token = "t".repeat(32);
type RequestBody = {
	version: "DEPLOY_PLAN_V1";
	digest: string;
	repository: string;
	targetId: string;
	commitSha: string;
	requestedBy: string;
	approvedBy: string;
};

describe("deploy executor", () => {
	test("rejects unauthenticated requests before running commands", async () => {
		const temp = await makeTemp();
		try {
			const handler = createDeployExecutorHandler({
				config: configFor(temp),
				run: async () => {
					throw new Error("should not run");
				},
			});
			const response = await handler(
				new Request("http://deploy.test/deploy", {
					method: "POST",
					body: JSON.stringify(workerRequestBody()),
				}),
			);
			expect(response.status).toBe(401);
		} finally {
			await rm(temp.root, { recursive: true, force: true });
		}
	});

	test("accepts the Worker deploy contract and returns an execution id", async () => {
		const temp = await makeTemp();
		try {
			const handler = createDeployExecutorHandler({
				config: configFor(temp),
				run: async (command) => ({
					stdout: command.join(" ").includes("rev-parse HEAD")
						? `${sha}\n`
						: "",
					stderr: "",
				}),
			});
			const response = await handler(
				new Request("http://deploy.test/deploy", {
					method: "POST",
					headers: {
						Authorization: `Bearer ${token}`,
						"Content-Type": "application/json",
						"Idempotency-Key": "deploy-contract",
					},
					body: JSON.stringify(workerRequestBody()),
				}),
			);
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				executionId: "deploy:deploy-contract",
				status: "succeeded",
				replayed: false,
			});
		} finally {
			await rm(temp.root, { recursive: true, force: true });
		}
	});

	test("runs exact deploy sequence and replays identical idempotency key", async () => {
		const temp = await makeTemp();
		const commands: string[][] = [];
		const run: CommandRunner = async (command) => {
			commands.push([...command]);
			if (command.join(" ").includes("rev-parse HEAD")) {
				return { stdout: `${sha}\n`, stderr: "" };
			}
			return { stdout: "", stderr: "" };
		};
		try {
			const config = configFor(temp);
			const first = await deployWithIdempotency({
				config,
				request: internalRequest(),
				run,
			});
			const second = await deployWithIdempotency({
				config,
				request: internalRequest(),
				run,
			});
			expect(first.replayed).toBe(false);
			expect(first.artifact.status).toBe("succeeded");
			expect(second.replayed).toBe(true);
			expect(second.artifact.id).toBe(first.artifact.id);
			expect(commands.map((command) => command[0])).toEqual([
				"git",
				"git",
				"git",
				"git",
				"docker",
				"mkdir",
				"rsync",
				"rsync",
				"docker",
				"curl",
			]);
			expect(commands[0]).toEqual([
				"git",
				"clone",
				"--filter=blob:none",
				"--no-checkout",
				repo,
				join(temp.stateDir, "staging", "deploy-1", "repo"),
			]);
			expect(commands[1]).toEqual([
				"git",
				"-C",
				join(temp.stateDir, "staging", "deploy-1", "repo"),
				"fetch",
				"--depth=1",
				"origin",
				sha,
			]);
			expect(commands.at(-1)).toEqual([
				"curl",
				"--retry",
				"10",
				"--retry-delay",
				"2",
				"--retry-all-errors",
				"--connect-timeout",
				"5",
				"--max-time",
				"60",
				"-fsS",
				"http://127.0.0.1:8642/health",
			]);
		} finally {
			await rm(temp.root, { recursive: true, force: true });
		}
	});

	test("returns rollback guidance without auto-rollback when healthcheck fails", async () => {
		const temp = await makeTemp();
		const commands: string[][] = [];
		const run: CommandRunner = async (command) => {
			commands.push([...command]);
			if (command.join(" ").includes("rev-parse HEAD")) {
				return { stdout: `${sha}\n`, stderr: "" };
			}
			if (command[0] === "curl") {
				throw new Error("health failed");
			}
			return { stdout: "", stderr: "" };
		};
		try {
			const result = await deployWithIdempotency({
				config: configFor(temp),
				request: internalRequest({ idempotencyKey: "deploy-rollback" }),
				run,
			});
			expect(result.artifact.status).toBe("failed");
			expect(result.artifact.rollbackGuidance?.reason).toBe("health failed");
			expect(result.artifact.rollbackGuidance?.commands).toHaveLength(2);
			expect(result.artifact.rollbackGuidance?.requiresSeparateApproval).toBe(
				true,
			);
			expect(commands.at(-1)?.[0]).toBe("curl");
		} finally {
			await rm(temp.root, { recursive: true, force: true });
		}
	});

	test("rejects non-allowlisted repo and mutable refs", async () => {
		const temp = await makeTemp();
		try {
			const config = configFor(temp);
			await expect(
				deployWithIdempotency({
					config,
					request: internalRequest({
						repo: "https://github.com/other/repo.git",
					}),
					run: async () => ({ stdout: "", stderr: "" }),
				}),
			).rejects.toThrow("repo is not allowlisted");
			await expect(
				deployWithIdempotency({
					config,
					request: internalRequest({ idempotencyKey: "deploy-2", sha: "main" }),
					run: async () => ({ stdout: "", stderr: "" }),
				}),
			).rejects.toThrow("sha must be a 40-character lowercase commit SHA");
		} finally {
			await rm(temp.root, { recursive: true, force: true });
		}
	});
});

function workerRequestBody(overrides: Partial<RequestBody> = {}): RequestBody {
	return {
		version: "DEPLOY_PLAN_V1",
		digest: "d".repeat(64),
		repository: "Pakzartl/poc-line-agent-hermes",
		targetId: "hermes-ovh",
		commitSha: sha,
		requestedBy: "requester",
		approvedBy: "approver",
		...overrides,
	};
}

function internalRequest(
	overrides: Partial<DeployRequest> = {},
): DeployRequest {
	return {
		repo,
		target: "hermes-ovh",
		sha,
		idempotencyKey: "deploy-1",
		requestedBy: "requester",
		...overrides,
	};
}

async function makeTemp() {
	const root = await mkdtemp(join(tmpdir(), "deploy-executor-test-"));
	const appDir = join(root, "app");
	const backupDir = join(root, "backups");
	const stateDir = join(root, "state");
	await mkdir(appDir, { recursive: true });
	return { root, appDir, backupDir, stateDir };
}

function configFor(temp: {
	appDir: string;
	backupDir: string;
	stateDir: string;
}) {
	return loadDeployExecutorConfig({
		DEPLOY_EXECUTOR_TOKEN: token,
		DEPLOY_EXECUTOR_STATE_DIR: temp.stateDir,
		DEPLOY_EXECUTOR_TARGETS_JSON: JSON.stringify([
			{
				id: "hermes-ovh",
				repo,
				appDir: temp.appDir,
				backupDir: temp.backupDir,
				healthUrl: "http://127.0.0.1:8642/health",
			},
		]),
	});
}
