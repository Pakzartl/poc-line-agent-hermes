import { describe, expect, test } from "bun:test";
import {
	formatHermesSourceInput,
	parseScopedTelegramMessage,
} from "./source-scope";

describe("Telegram source scope", () => {
	test("parses repository and any valid Git ref from the first two non-empty lines", () => {
		expect(
			parseScopedTelegramMessage(
				"\nbranch: feature/rate-limit\nrepo: codemonday-dev/lms-backend\n\nlearner gateway จำกัดเท่าไหร่",
			),
		).toEqual({
			ok: true,
			value: {
				repository: "codemonday-dev/lms-backend",
				branch: "feature/rate-limit",
				question: "learner gateway จำกัดเท่าไหร่",
			},
		});
	});

	test("rejects missing, duplicated, invalid, or questionless scope", () => {
		expect(parseScopedTelegramMessage("ดู rate limit ให้หน่อย")).toEqual({
			ok: false,
			reason: "missing_scope",
		});
		expect(
			parseScopedTelegramMessage("repo: acme/api\nrepo: acme/web\nquestion"),
		).toEqual({ ok: false, reason: "invalid_scope" });
		expect(
			parseScopedTelegramMessage("repo: acme/api\nbranch: ../main\nquestion"),
		).toEqual({ ok: false, reason: "invalid_scope" });
		expect(parseScopedTelegramMessage("repo: acme/api\nbranch: main")).toEqual({
			ok: false,
			reason: "missing_question",
		});
	});

	test("formats an anchored scope envelope for Hermes hooks", () => {
		expect(
			formatHermesSourceInput({
				repository: "acme/api",
				branch: "dev",
				question: "find the limiter",
			}),
		).toBe(
			'POC_SOURCE_SCOPE_V1 {"repository":"acme/api","branch":"dev"}\n\nfind the limiter',
		);
	});
});
