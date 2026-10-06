import { describe, expect, test } from "bun:test";
import { createBunSkillLoader } from "./bun-skill-loader";
import { createSkillManager, skillNames } from "./skill-manager";

describe("skill manager", () => {
	const manager = createSkillManager(createBunSkillLoader());

	test.each([
		["ช่วยสรุป repo นี้ให้หน่อย", "repo-overview"],
		["โค้ด login อยู่ไฟล์ไหน", "find-code"],
		["อธิบายโค้ดไฟล์ auth ให้หน่อย", "explain-code"],
		["ช่วยไล่ flow ของ webhook", "trace-feature"],
		["commit ล่าสุดเปลี่ยนอะไร", "recent-changes"],
		["ช่วย review commit abc123", "commit-review"],
		["รีวิว PR #42", "pr-review"],
		["error 403 นี้เกิดจากอะไร", "bug-investigator"],
		["test ไหนเกี่ยวกับ webhook", "test-finder"],
		["ขาด test อะไรบ้าง", "missing-tests"],
		["package นี้ใช้ตรงไหน", "dependency-check"],
		["ดูความปลอดภัย auth ให้หน่อย", "security-review"],
		["ค่า env นี้ใช้ตรงไหน", "config-explainer"],
		["endpoint อะไรบ้าง", "api-catalog"],
		["database schema เป็นยังไง", "database-map"],
		["ทำ architecture map ให้หน่อย", "architecture-map"],
		["ทำ guide เริ่ม dev สำหรับคนใหม่", "onboarding-guide"],
		["สรุป release ระหว่าง tag A กับ B", "release-summary"],
		["incident ระบบล่มเมื่อคืน", "incident-triage"],
		["เทียบ repo api กับ web", "repo-comparison"],
		["ใช้ $find-code หา config", "find-code"],
		["ช่วยทำ risk assessment ก่อน release", "risk-assessment"],
		["วางแผน deploy commit นี้ให้หน่อย", "deploy"],
		[
			"list custom ratelimit ออกมาให้หน่อย บอก api ไหนใช้ rate limit อะไร",
			"code-scan",
		],
		[
			"scan ทุก gateway แล้วหาว่า request policy ถูก register ไว้ที่ไหนบ้าง",
			"code-scan",
		],
		["ช่วยตรวจทั้ง repo ว่าฟีเจอร์นี้ต่อกันยังไง", "code-scan"],
	] as const)("routes %s to %s", (question, expected) => {
		expect(manager.selectSkill(question)).toBe(expected);
	});

	test("registers the full skill catalog", () => {
		expect(skillNames).toHaveLength(23);
		expect(skillNames).toContain("code-scan");
		expect(skillNames).toContain("risk-assessment");
		expect(skillNames).toContain("deploy");
		expect(skillNames).not.toContain("rate-limit-audit");
	});

	test("loads every registered skill document", async () => {
		for (const name of skillNames) {
			const markdown = await manager.loadSkill(name);
			expect(markdown.length).toBeGreaterThan(100);
			expect(markdown).not.toContain("TODO");
		}
	});
});
