export const skillNames = [
	"repo-overview",
	"find-code",
	"code-scan",
	"explain-code",
	"trace-feature",
	"recent-changes",
	"commit-review",
	"pr-review",
	"bug-investigator",
	"test-finder",
	"missing-tests",
	"dependency-check",
	"security-review",
	"config-explainer",
	"api-catalog",
	"database-map",
	"architecture-map",
	"onboarding-guide",
	"release-summary",
	"incident-triage",
	"repo-comparison",
	"risk-assessment",
	"deploy",
] as const;

export type SkillName = (typeof skillNames)[number];

const skillKeywords: { name: SkillName; terms: string[] }[] = [
	{
		name: "deploy",
		terms: [
			"$deploy",
			"deployment plan",
			"deploy plan",
			"วางแผน deploy",
			"แผน deploy",
		],
	},
	{
		name: "risk-assessment",
		terms: [
			"$risk-assessment",
			"risk assessment",
			"blast radius",
			"human test plan",
			"ประเมินความเสี่ยง",
		],
	},
	{
		name: "code-scan",
		terms: [
			"code scan",
			"scan code",
			"scan repo",
			"search the repo",
			"across repo",
			"whole repo",
			"entire repo",
			"all gateways",
			"ทุก gateway",
			"ทั้ง repo",
			"ตรวจทั้ง repo",
			"ค้นทั้ง repo",
			"ไล่ทั้ง repo",
			"rate limit",
			"ratelimit",
			"rate-limit",
			"throttle",
			"429",
			"จำกัด request",
			"จำกัดคำขอ",
		],
	},
	{
		name: "repo-comparison",
		terms: [
			"compare repos",
			"compare repositories",
			"เทียบ repo",
			"เปรียบเทียบ repo",
		],
	},
	{
		name: "release-summary",
		terms: [
			"release summary",
			"compare tags",
			"compare commits",
			"changelog",
			"สรุป release",
			"เทียบ tag",
		],
	},
	{
		name: "incident-triage",
		terms: [
			"incident",
			"production issue",
			"outage",
			"triage",
			"ระบบล่ม",
			"incident",
		],
	},
	{
		name: "pr-review",
		terms: [
			"pr review",
			"pull request review",
			"review pr",
			"pull request",
			"รีวิว pr",
			"ดู pr",
		],
	},
	{
		name: "commit-review",
		terms: [
			"commit review",
			"review commit",
			"ดู commit",
			"รีวิว commit",
			"commit เสี่ยง",
		],
	},
	{
		name: "security-review",
		terms: [
			"security review",
			"hardcoded secret",
			"auth bypass",
			"overprivilege",
			"ความปลอดภัย",
			"ช่องโหว่",
			"secret หลุด",
		],
	},
	{
		name: "missing-tests",
		terms: [
			"missing tests",
			"test gaps",
			"what tests are missing",
			"ขาด test",
			"ควรเพิ่ม test",
		],
	},
	{
		name: "test-finder",
		terms: [
			"find tests",
			"related tests",
			"which tests",
			"test ไหน",
			"หา test",
		],
	},
	{
		name: "dependency-check",
		terms: [
			"dependency",
			"package",
			"library",
			"version",
			"dependencies",
			"แพ็กเกจ",
			"ไลบรารี",
		],
	},
	{
		name: "config-explainer",
		terms: [
			"config",
			"environment variable",
			"env var",
			"ตั้งค่า",
			"ค่า env",
			"config ใช้ตรงไหน",
		],
	},
	{
		name: "api-catalog",
		terms: [
			"api catalog",
			"endpoints",
			"routes",
			"http api",
			"endpoint อะไร",
			"route อะไร",
		],
	},
	{
		name: "database-map",
		terms: ["database", "schema", "migration", "model", "db map", "ฐานข้อมูล"],
	},
	{
		name: "architecture-map",
		terms: [
			"architecture map",
			"module map",
			"dependency map",
			"system map",
			"ภาพรวม architecture",
			"map ระบบ",
		],
	},
	{
		name: "onboarding-guide",
		terms: [
			"onboarding",
			"new dev guide",
			"getting started",
			"เริ่ม dev",
			"คนใหม่",
		],
	},
	{
		name: "recent-changes",
		terms: [
			"recent changes",
			"latest changes",
			"latest commits",
			"recent commits",
			"commit ล่าสุด",
			"เปลี่ยนอะไรล่าสุด",
			"ใครแก้",
		],
	},
	{
		name: "trace-feature",
		terms: [
			"trace feature",
			"trace flow",
			"call flow",
			"data flow",
			"request flow",
			"ไล่ flow",
			"ไล่เส้นทาง",
			"เส้นทางการทำงาน",
		],
	},
	{
		name: "explain-code",
		terms: [
			"explain code",
			"explain file",
			"what does this code",
			"อธิบายโค้ด",
			"อธิบายไฟล์",
		],
	},
	{
		name: "find-code",
		terms: [
			"find code",
			"search code",
			"where is",
			"which file",
			"หาโค้ด",
			"อยู่ไฟล์ไหน",
			"อยู่ตรงไหน",
		],
	},
	{
		name: "bug-investigator",
		terms: [
			"bug",
			"error",
			"failed",
			"fail",
			"500",
			"debug",
			"exception",
			"why",
			"พัง",
			"ผิดพลาด",
			"หาสาเหตุ",
			"ทำไม",
		],
	},
	{
		name: "repo-overview",
		terms: [
			"repo overview",
			"repository overview",
			"summarize repo",
			"what does this repo",
			"ภาพรวม repo",
			"สรุป repo",
			"repo ทำอะไร",
			"โครงสร้าง repo",
		],
	},
];

export type SkillManager = {
	selectSkill(question: string): SkillName;
	loadSkill(name: SkillName): Promise<string>;
};

export type SkillLoader = (name: SkillName) => Promise<string>;

export function createSkillManager(loadSkill: SkillLoader): SkillManager {
	return {
		selectSkill(question) {
			const normalized = question.toLowerCase();
			return (
				skillNames.find(
					(name) =>
						normalized.includes(`$${name}`) || normalized.includes(name),
				) ??
				skillKeywords.find((skill) =>
					skill.terms.some((term) => normalized.includes(term)),
				)?.name ??
				"repo-overview"
			);
		},
		loadSkill,
	};
}
