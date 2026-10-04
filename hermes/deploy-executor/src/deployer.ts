import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DeployExecutorConfig, DeployTarget } from "./config";

export type DeployRequest = {
	repo: string;
	target: string;
	sha: string;
	idempotencyKey: string;
	requestedBy?: string;
};

export type DeployArtifact = {
	id: string;
	status: "succeeded" | "failed";
	target: string;
	repo: string;
	sha: string;
	idempotencyKey: string;
	startedAt: string;
	finishedAt: string;
	stagedCommit: string;
	backupPath: string;
	commands: readonly string[];
	rollbackGuidance?: {
		requiresSeparateApproval: true;
		commands: readonly string[];
		reason: string;
	};
	error?: string;
};

export type CommandRunner = (
	command: readonly string[],
	options: { cwd?: string },
) => Promise<{ stdout: string; stderr: string }>;

const keyPattern = /^[A-Za-z0-9._:-]{8,128}$/;

export async function deployWithIdempotency(input: {
	config: DeployExecutorConfig;
	request: DeployRequest;
	run?: CommandRunner;
	now?: () => Date;
}): Promise<{ artifact: DeployArtifact; replayed: boolean }> {
	const requestHash = hashRequest(input.request);
	if (!keyPattern.test(input.request.idempotencyKey)) {
		throw new DeployInputError("idempotencyKey is invalid");
	}
	const recordsDir = join(input.config.stateDir, "records");
	const locksDir = join(input.config.stateDir, "locks");
	await mkdir(recordsDir, { recursive: true, mode: 0o700 });
	await mkdir(locksDir, { recursive: true, mode: 0o700 });
	const recordPath = join(recordsDir, `${input.request.idempotencyKey}.json`);
	const lockPath = join(locksDir, `${input.request.idempotencyKey}.lock`);
	const existing = await readExistingRecord(recordPath);
	if (existing) {
		if (existing.requestHash !== requestHash) {
			throw new DeployConflictError(
				"idempotencyKey was already used with different input",
			);
		}
		return { artifact: existing.artifact, replayed: true };
	}
	try {
		await writeFile(lockPath, requestHash, { flag: "wx", mode: 0o600 });
	} catch (error) {
		if ((error as { code?: string }).code === "EEXIST") {
			throw new DeployConflictError("deployment is already running");
		}
		throw error;
	}
	try {
		const artifact = await executeDeploy({
			config: input.config,
			request: input.request,
			run: input.run ?? runCommand,
			now: input.now ?? (() => new Date()),
		});
		await writeFile(
			recordPath,
			JSON.stringify({ requestHash, artifact }, null, 2),
			{ mode: 0o600 },
		);
		return { artifact, replayed: false };
	} finally {
		await rm(lockPath, { force: true });
	}
}

async function executeDeploy(input: {
	config: DeployExecutorConfig;
	request: DeployRequest;
	run: CommandRunner;
	now: () => Date;
}): Promise<DeployArtifact> {
	const target = findTarget(input.config, input.request);
	const startedAt = input.now().toISOString();
	const artifactId = `deploy:${input.request.idempotencyKey}`;
	const stageDir = join(
		input.config.stateDir,
		"staging",
		input.request.idempotencyKey,
	);
	const repoDir = join(stageDir, "repo");
	const backupPath = join(
		target.backupDir,
		`${target.id}-${input.request.sha}-${input.request.idempotencyKey}`,
	);
	const commands: string[] = [];
	const run = async (
		command: readonly string[],
		options: { cwd?: string } = {},
	) => {
		commands.push(renderCommand(command));
		return input.run(command, options);
	};
	const rollbackGuidance = (reason: string) => {
		const restore = [
			"rsync",
			"-a",
			"--delete",
			"--exclude",
			"env.local",
			`${backupPath}/`,
			`${target.appDir}/`,
		];
		const restart = composeCommand(target, ["up", "-d", "--build"]);
		return {
			requiresSeparateApproval: true as const,
			commands: [renderCommand(restore), renderCommand(restart)],
			reason,
		};
	};
	let stagedCommit = "";
	await rm(stageDir, { recursive: true, force: true });
	await mkdir(stageDir, { recursive: true, mode: 0o700 });
	try {
		await run([
			"git",
			"clone",
			"--filter=blob:none",
			"--no-checkout",
			target.repo,
			repoDir,
		]);
		await run([
			"git",
			"-C",
			repoDir,
			"fetch",
			"--depth=1",
			"origin",
			input.request.sha,
		]);
		await run([
			"git",
			"-C",
			repoDir,
			"checkout",
			"--detach",
			input.request.sha,
		]);
		const rev = await run(["git", "-C", repoDir, "rev-parse", "HEAD"]);
		stagedCommit = rev.stdout.trim();
		if (stagedCommit !== input.request.sha) {
			throw new Error("staged commit does not match requested SHA");
		}
		await run([
			"docker",
			"compose",
			"-f",
			join(repoDir, target.composeFile),
			"--env-file",
			join(target.appDir, "env.local"),
			"config",
			"--quiet",
		]);
		await run(["mkdir", "-p", target.backupDir]);
		await run([
			"rsync",
			"-a",
			"--delete",
			"--exclude",
			"env.local",
			`${target.appDir}/`,
			`${backupPath}/`,
		]);
		try {
			await run([
				"rsync",
				"-a",
				"--delete",
				"--exclude",
				"env.local",
				`${join(repoDir, target.sourceSubdir)}/`,
				`${target.appDir}/`,
			]);
			await run(composeCommand(target, ["up", "-d", "--build"]));
			await run([
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
				target.healthUrl,
			]);
			return {
				id: artifactId,
				status: "succeeded",
				target: target.id,
				repo: target.repo,
				sha: input.request.sha,
				idempotencyKey: input.request.idempotencyKey,
				startedAt,
				finishedAt: input.now().toISOString(),
				stagedCommit,
				backupPath,
				commands,
			};
		} catch (error) {
			const guidance = rollbackGuidance(
				error instanceof Error ? error.message : "deployment failed",
			);
			return {
				id: artifactId,
				status: "failed",
				target: target.id,
				repo: target.repo,
				sha: input.request.sha,
				idempotencyKey: input.request.idempotencyKey,
				startedAt,
				finishedAt: input.now().toISOString(),
				stagedCommit,
				backupPath,
				commands,
				rollbackGuidance: guidance,
				error: guidance.reason,
			};
		}
	} finally {
		await rm(stageDir, { recursive: true, force: true });
	}
}

function findTarget(
	config: DeployExecutorConfig,
	request: DeployRequest,
): DeployTarget {
	const target = config.targets.find(
		(candidate) => candidate.id === request.target,
	);
	if (!target) {
		throw new DeployInputError("target is not allowlisted");
	}
	if (request.repo !== target.repo) {
		throw new DeployInputError("repo is not allowlisted");
	}
	if (!/^[0-9a-f]{40}$/.test(request.sha)) {
		throw new DeployInputError(
			"sha must be a 40-character lowercase commit SHA",
		);
	}
	return target;
}

function composeCommand(
	target: DeployTarget,
	tail: readonly string[],
): string[] {
	return [
		"docker",
		"compose",
		"-f",
		join(target.appDir, "compose.yaml"),
		"--env-file",
		join(target.appDir, "env.local"),
		...tail,
	];
}

async function readExistingRecord(
	path: string,
): Promise<{ requestHash: string; artifact: DeployArtifact } | null> {
	try {
		const raw = await readFile(path, "utf8");
		return JSON.parse(raw) as { requestHash: string; artifact: DeployArtifact };
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") return null;
		throw error;
	}
}

function hashRequest(request: DeployRequest): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				repo: request.repo,
				target: request.target,
				sha: request.sha,
				idempotencyKey: request.idempotencyKey,
			}),
		)
		.digest("hex");
}

function renderCommand(command: readonly string[]): string {
	return command.map((part) => JSON.stringify(part)).join(" ");
}

export async function runCommand(
	command: readonly string[],
	options: { cwd?: string },
): Promise<{ stdout: string; stderr: string }> {
	const subprocess = Bun.spawn([...command], {
		cwd: options.cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(subprocess.stdout).text(),
		new Response(subprocess.stderr).text(),
		subprocess.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(
			`${command[0]} exited with ${exitCode}: ${stderr || stdout}`.trim(),
		);
	}
	return { stdout, stderr };
}

export class DeployInputError extends Error {}
export class DeployConflictError extends Error {}
