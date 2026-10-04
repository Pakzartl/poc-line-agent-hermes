const stringOptionType = 3;
const integerOptionType = 4;

const repositoryOption = {
	type: stringOptionType,
	name: "repository",
	description: "GitHub owner/name (autocomplete uses the configured token)",
	required: true,
	autocomplete: true,
} as const;

const branchOption = {
	type: stringOptionType,
	name: "branch",
	description: "Git branch to inspect",
	required: true,
	autocomplete: true,
} as const;

const questionOption = {
	type: stringOptionType,
	name: "question",
	description: "What you want the agent to inspect",
	required: true,
	min_length: 1,
	max_length: 4_000,
} as const;

export const discordCommands = [
	{
		name: "code",
		description: "Inspect a GitHub repository and branch with Hermes",
		options: [repositoryOption, branchOption, questionOption],
	},
	{
		name: "risk",
		description: "Create a risk assessment and human test plan from code",
		options: [
			repositoryOption,
			branchOption,
			{
				type: stringOptionType,
				name: "change",
				description: "Implementation or deployment change to assess",
				required: true,
				min_length: 1,
				max_length: 4_000,
			},
			{
				type: stringOptionType,
				name: "base_ref",
				description: "Optional base branch/tag/SHA to compare with branch",
				required: false,
				autocomplete: true,
				min_length: 1,
				max_length: 200,
			},
			{
				type: integerOptionType,
				name: "pull_request",
				description: "Optional GitHub pull request number",
				required: false,
				min_value: 1,
			},
			{
				type: stringOptionType,
				name: "context",
				description: "Optional extra rollout, config, or test context",
				required: false,
				min_length: 1,
				max_length: 2_000,
			},
		],
	},
	{
		name: "db",
		description: "Ask a bounded read-only database question",
		options: [
			{
				...questionOption,
				description: "Question or explicit read-only SELECT/WITH query",
			},
		],
	},
	{
		name: "artifact",
		description: "Create a document, data, diagram, or screenshot artifact",
		options: [
			{
				type: stringOptionType,
				name: "kind",
				description: "Artifact format",
				required: true,
				choices: [
					{ name: "Markdown document", value: "markdown" },
					{ name: "JSON data", value: "json" },
					{ name: "CSV table", value: "csv" },
					{ name: "Mermaid diagram", value: "diagram" },
					{ name: "Screenshot", value: "screenshot" },
				],
			},
			{
				type: stringOptionType,
				name: "request",
				description: "Artifact to create or capture",
				required: true,
				min_length: 1,
				max_length: 4_000,
			},
			{
				type: stringOptionType,
				name: "target_id",
				description:
					"Required for screenshot; server-side allowlisted target id",
				required: false,
				autocomplete: true,
				min_length: 1,
				max_length: 200,
			},
		],
	},
	{
		name: "deploy",
		description: "Prepare an approval-gated deploy request",
		options: [
			repositoryOption,
			{
				type: stringOptionType,
				name: "commit_sha",
				description: "Immutable 40-character git commit SHA to deploy",
				required: true,
				min_length: 40,
				max_length: 40,
			},
			{
				type: stringOptionType,
				name: "target",
				description: "Deployment target",
				required: true,
				autocomplete: true,
				min_length: 1,
				max_length: 200,
			},
			{
				type: stringOptionType,
				name: "context",
				description: "Optional rollout or approval context",
				required: false,
				max_length: 2_000,
			},
		],
	},
	{
		name: "status",
		description: "Check capability job or approval status",
		options: [
			{
				type: stringOptionType,
				name: "request_id",
				description: "Optional request id from an earlier capability job",
				required: false,
				min_length: 1,
				max_length: 200,
			},
		],
	},
	{
		name: "cancel",
		description: "Cancel a queued or running non-deploy capability job",
		options: [
			{
				type: stringOptionType,
				name: "request_id",
				description: "Request id from the capability response",
				required: true,
				min_length: 1,
				max_length: 200,
			},
		],
	},
	{
		name: "skills",
		description: "List available Javis capability commands",
	},
	{
		name: "clear",
		description: "Clear your Hermes conversation for this Discord channel",
	},
] as const;

export async function registerDiscordCommands(input: {
	applicationId: string;
	botToken: string;
	guildId?: string;
	apiBaseUrl?: string;
	fetch?: typeof fetch;
}): Promise<void> {
	const apiBaseUrl = (
		input.apiBaseUrl ?? "https://discord.com/api/v10"
	).replace(/\/+$/, "");
	const path = input.guildId
		? `/applications/${encodeURIComponent(input.applicationId)}/guilds/${encodeURIComponent(input.guildId)}/commands`
		: `/applications/${encodeURIComponent(input.applicationId)}/commands`;
	const response = await (input.fetch ?? fetch)(`${apiBaseUrl}${path}`, {
		method: "PUT",
		headers: {
			Authorization: `Bot ${input.botToken}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(discordCommands),
	});
	if (!response.ok) {
		const detail = (await response.text()).slice(0, 500);
		throw new Error(
			`Discord command registration failed with status ${response.status}: ${detail}`,
		);
	}
}

if (import.meta.main) {
	const applicationId = Bun.env.DISCORD_APPLICATION_ID?.trim();
	const botToken = Bun.env.DISCORD_BOT_TOKEN?.trim();
	if (!applicationId || !botToken) {
		throw new Error(
			"DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN are required",
		);
	}
	await registerDiscordCommands({
		applicationId,
		botToken,
		guildId: Bun.env.DISCORD_GUILD_ID?.trim() || undefined,
		apiBaseUrl: Bun.env.DISCORD_API_BASE_URL?.trim() || undefined,
	});
	console.log("Discord application commands registered");
}
