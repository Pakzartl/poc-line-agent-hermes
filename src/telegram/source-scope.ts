export type SourceScope = {
	repository: string;
	branch: string;
};

export type ScopedTelegramMessage = SourceScope & {
	question: string;
};

export type SourceScopeParseResult =
	| { ok: true; value: ScopedTelegramMessage }
	| {
			ok: false;
			reason: "missing_scope" | "invalid_scope" | "missing_question";
	  };

export const sourceScopeHelpMessage = [
	"กรุณาระบุ repo และ branch ไว้ 2 บรรทัดแรกของข้อความ เช่น:",
	"repo: codemonday-dev/lms-backend",
	"branch: dev",
	"คำถามที่ต้องการให้ตรวจโค้ด",
].join("\n");

const sourceScopePrefix = "POC_SOURCE_SCOPE_V1 ";
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const invalidGitRefPattern = /[\x00-\x20~^:?*\[\]\\]/;

export function parseScopedTelegramMessage(
	text: string,
): SourceScopeParseResult {
	const lines = text.split(/\r?\n/);
	const scopeLineIndexes: number[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		if (lines[index]?.trim()) {
			scopeLineIndexes.push(index);
			if (scopeLineIndexes.length === 2) {
				break;
			}
		}
	}
	if (scopeLineIndexes.length < 2) {
		return { ok: false, reason: "missing_scope" };
	}

	const scope = new Map<string, string>();
	for (const index of scopeLineIndexes) {
		const match = /^(repo|branch)\s*:\s*(.+)$/i.exec(
			lines[index]?.trim() ?? "",
		);
		if (!match) {
			return { ok: false, reason: "missing_scope" };
		}
		const key = match[1]?.toLowerCase();
		const value = match[2]?.trim();
		if (!key || !value || scope.has(key)) {
			return { ok: false, reason: "invalid_scope" };
		}
		scope.set(key, value);
	}

	const repository = scope.get("repo") ?? "";
	const branch = scope.get("branch") ?? "";
	if (!isValidRepository(repository) || !isValidGitRef(branch)) {
		return { ok: false, reason: "invalid_scope" };
	}

	const excluded = new Set(scopeLineIndexes);
	const question = lines
		.filter((_, index) => !excluded.has(index))
		.join("\n")
		.trim();
	if (!question) {
		return { ok: false, reason: "missing_question" };
	}

	return {
		ok: true,
		value: { repository, branch, question },
	};
}

export function formatHermesSourceInput(input: ScopedTelegramMessage): string {
	const scope = JSON.stringify({
		repository: input.repository,
		branch: input.branch,
	});
	return `${sourceScopePrefix}${scope}\n\n${input.question}`;
}

export function isValidRepository(repository: string): boolean {
	return repository.length <= 201 && repositoryPattern.test(repository);
}

export function isValidGitRef(branch: string): boolean {
	return (
		branch.length > 0 &&
		branch.length <= 200 &&
		!branch.startsWith("/") &&
		!branch.endsWith("/") &&
		!branch.includes("..") &&
		!branch.includes("@{") &&
		!invalidGitRefPattern.test(branch)
	);
}
