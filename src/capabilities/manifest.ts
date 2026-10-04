export type CapabilityPermission =
	| "github:read"
	| "database:read"
	| "artifact:create"
	| "deploy:mutate"
	| "event:ingest";

export type CapabilityManifest = {
	id: string;
	name: string;
	description: string;
	inputContract: string;
	permissions: readonly CapabilityPermission[];
	steps: readonly string[];
	outputArtifact: string;
	verification: readonly string[];
	failureBehavior: string;
	demo: string;
	requiresApproval?: boolean;
	approvalDeclaration?: string;
};

const mutationPermissions = new Set<CapabilityPermission>(["deploy:mutate"]);

export const capabilityManifests = [
	{
		id: "code-investigation",
		name: "/code",
		description:
			"Inspect repository code and point to files, functions, and evidence.",
		inputContract:
			"repository owner/name, branch/ref, natural-language question",
		permissions: ["github:read"],
		steps: [
			"Validate repository and branch",
			"Clone or read source through Hermes GitHub tools",
			"Search the codebase before answering",
			"Return cited findings and a HIL investigation artifact",
		],
		outputArtifact: "Code investigation HIL artifact with cited evidence",
		verification: [
			"Repository and branch are explicit",
			"Answer cites paths or explains missing evidence",
			"Discord reply includes a markdown artifact attachment",
		],
		failureBehavior:
			"Fail closed with a retryable queue error or a human-readable configuration gap.",
		demo: "/code repository:codemonday-dev/lms-backend branch:dev question:where is rate limit configured?",
	},
	{
		id: "risk-assessment",
		name: "/risk",
		description:
			"Assess blast radius, side effects, and where humans should test before release.",
		inputContract:
			"repository owner/name, branch/ref, change description, optional rollout context",
		permissions: ["github:read"],
		steps: [
			"Validate source scope",
			"Inspect implementation and deployment surface",
			"Identify blast radius, side effects, and test locations",
			"Return a Human Test Plan and HIL artifact",
		],
		outputArtifact: "Risk assessment HIL artifact plus Human Test Plan",
		verification: [
			"Blast radius is stated",
			"Side effects are listed",
			"Human test plan is actionable",
		],
		failureBehavior:
			"Fail closed if code evidence is unavailable or source scope is invalid.",
		demo: "/risk repository:codemonday-dev/lms-backend branch:dev change:deploy learner gateway throttling",
	},
	{
		id: "queue-failure",
		name: "queue-failure event",
		description:
			"Convert retry-exhausted queue failures into a one-screen HIL artifact.",
		inputContract:
			"signed queue-failure/v1 JSON event with queue, job, attempts, error, and optional logs/entity",
		permissions: ["event:ingest"],
		steps: [
			"Verify HMAC signature",
			"Sanitize payload, logs, and entity data",
			"Classify likely failure category",
			"Return and optionally post a one-screen HIL artifact",
		],
		outputArtifact: "Queue failure HIL artifact",
		verification: [
			"Unsigned events are rejected",
			"Secrets and emails are redacted",
			"Failure classification is deterministic",
		],
		failureBehavior:
			"Reject invalid events with 4xx; return 503 when the ingest secret is not configured.",
		demo: "POST /events/queue-failure with X-Javis-Signature: sha256=...",
	},
	{
		id: "db-read",
		name: "/db",
		description:
			"Execute an explicit bounded read-only query or clearly report missing DB tooling.",
		inputContract:
			"explicit SELECT/WITH query; natural-language execution is disabled until a schema-grounded planner is configured",
		permissions: ["database:read"],
		steps: [
			"Refuse mutations",
			"Require a configured read-only adapter and table/schema allowlist",
			"Return a bounded answer and HIL artifact",
		],
		outputArtifact: "Read-only database HIL artifact",
		verification: [
			"No write SQL is accepted",
			"Answer states whether live data was queried",
			"Artifact includes the data source and limitations",
		],
		failureBehavior:
			"Never execute SQL without read-only adapter configuration.",
		demo: "/db question:SELECT status, count(*) FROM reporting.course_progress GROUP BY status",
	},
	{
		id: "artifact",
		name: "/artifact",
		description:
			"Create Markdown, JSON, CSV, Mermaid diagram, or an allowlisted screenshot artifact.",
		inputContract:
			"artifact kind and request; screenshots additionally require a server-side allowlisted target id",
		permissions: ["artifact:create"],
		steps: [
			"Validate the requested artifact kind and bounded model output",
			"For screenshots, validate the server-side target allowlist and call the sandboxed renderer",
			"Attach the artifact to the Discord response",
		],
		outputArtifact: "Markdown, JSON, CSV, Mermaid text, PNG, or JPEG artifact",
		verification: [
			"Structured JSON/CSV output is parsed before attachment",
			"No user-provided URL reaches the screenshot renderer",
		],
		failureBehavior:
			"Reject invalid structured output and fail closed without opening a page when the renderer or target allowlist is unavailable.",
		demo: "/artifact kind:diagram request:draw the request lifecycle",
	},
	{
		id: "deploy",
		name: "/deploy",
		description:
			"Prepare an approval-gated deployment plan without mutating production automatically.",
		inputContract:
			"allowlisted repository and target, immutable 40-character commit SHA, optional context",
		permissions: ["deploy:mutate"],
		steps: [
			"Create a deployment plan",
			"State checks, risk, and rollback",
			"Require explicit approval before any external mutation",
		],
		outputArtifact: "Deployment plan HIL artifact",
		verification: [
			"Plan includes target, ref, checks, risk, rollback, and approval requirement",
			"No deploy executor is called from normal chat generation",
		],
		failureBehavior:
			"Fail closed when target, ref, approval, or executor configuration is missing.",
		demo: "/deploy repository:owner/repo commit_sha:<40-char-sha> target:worker-dev",
		requiresApproval: true,
		approvalDeclaration:
			"Deploy mutates external infrastructure and must only run after an explicit approval bound to the immutable plan digest.",
	},
] as const satisfies readonly CapabilityManifest[];

export function validateCapabilityManifest(
	manifest: CapabilityManifest,
): string[] {
	const errors: string[] = [];
	for (const field of [
		"id",
		"name",
		"description",
		"inputContract",
		"outputArtifact",
		"failureBehavior",
		"demo",
	] as const) {
		if (!manifest[field].trim()) {
			errors.push(`${manifest.id || "capability"} is missing ${field}`);
		}
	}
	if (manifest.steps.length === 0) {
		errors.push(`${manifest.id} must document at least one step`);
	}
	if (manifest.verification.length === 0) {
		errors.push(`${manifest.id} must document verification`);
	}
	if (
		manifest.permissions.some((permission) =>
			mutationPermissions.has(permission),
		) &&
		(!manifest.requiresApproval || !manifest.approvalDeclaration?.trim())
	) {
		errors.push(
			`${manifest.id} mutates external state and must declare approval`,
		);
	}
	return errors;
}

export function assertValidCapabilityManifests(
	manifests: readonly CapabilityManifest[] = capabilityManifests,
): void {
	const errors = manifests.flatMap(validateCapabilityManifest);
	if (errors.length > 0) {
		throw new Error(errors.join("; "));
	}
}

export function listCapabilityManifests(): CapabilityManifest[] {
	assertValidCapabilityManifests();
	return capabilityManifests.map((manifest) => ({ ...manifest }));
}

export function renderCapabilityList(): string {
	return listCapabilityManifests()
		.map(
			(manifest) =>
				`**${manifest.name}**\n${manifest.description}\nOutput: ${manifest.outputArtifact}\nDemo: \`${manifest.demo}\``,
		)
		.join("\n\n");
}
