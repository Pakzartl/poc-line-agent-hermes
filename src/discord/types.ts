export const DiscordInteractionType = {
	ping: 1,
	applicationCommand: 2,
	messageComponent: 3,
	applicationCommandAutocomplete: 4,
} as const;

export const DiscordInteractionResponseType = {
	pong: 1,
	channelMessage: 4,
	deferredChannelMessage: 5,
	deferredUpdateMessage: 6,
	autocompleteResult: 8,
} as const;

export const discordEphemeralFlag = 1 << 6;

export type DiscordCommandOption = {
	name: string;
	value?: string | number | boolean;
	focused?: boolean;
	options?: DiscordCommandOption[];
};

export type DiscordInteraction = {
	id: string;
	application_id: string;
	type: number;
	token: string;
	channel_id?: string;
	guild_id?: string;
	member?: { user?: DiscordUser };
	user?: DiscordUser;
	data?: {
		name?: string;
		custom_id?: string;
		options?: DiscordCommandOption[];
	};
};

export type DiscordUser = {
	id: string;
	bot?: boolean;
};

export type DiscordArtifactKind =
	| "markdown"
	| "json"
	| "csv"
	| "diagram"
	| "screenshot";

export type DiscordInteractionResponse = {
	type: number;
	data?: Record<string, unknown>;
};

export type DiscordCapabilityPayload =
	| {
			kind: "code_investigation";
			repository: string;
			branch: string;
			question: string;
	  }
	| {
			kind: "risk_assessment";
			repository: string;
			branch: string;
			change: string;
			context?: string;
			baseRef?: string;
			pullRequest?: number;
	  }
	| {
			kind: "database_query";
			question: string;
	  }
	| {
			kind: "artifact_request";
			artifactKind: DiscordArtifactKind;
			request: string;
			targetId?: string;
	  }
	| {
			kind: "deploy_request";
			repository: string;
			commitSha: string;
			target: string;
			context?: string;
	  }
	| {
			kind: "status";
			requestId?: string;
	  }
	| {
			kind: "skills";
	  };

export type DiscordCapabilityJobFields = {
	capability: DiscordCapabilityPayload;
};
