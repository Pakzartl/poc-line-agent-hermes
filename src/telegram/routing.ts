import type { AppConfig } from "../config";

export type TelegramAgentRoute = "legacy" | "hermes";

export function selectTelegramAgentRoute(input: {
	config: AppConfig;
	userId?: string;
	hasHermesClient: boolean;
}): TelegramAgentRoute {
	if (!input.hasHermesClient || input.config.runtime.mode === "legacy") {
		return "legacy";
	}
	if (input.config.runtime.mode === "hermes") {
		return "hermes";
	}
	if (!input.userId) {
		return "legacy";
	}
	return input.config.hermes.telegramAllowedUserIds.includes(input.userId)
		? "hermes"
		: "legacy";
}

export function routeUsesLegacy(config: AppConfig): boolean {
	if (config.runtime.mode === "legacy" || config.runtime.mode === "fallback") {
		return true;
	}
	return isLineConfigured(config) || isWhatsAppConfigured(config);
}

function isLineConfigured(config: AppConfig): boolean {
	return Boolean(config.line.channelSecret && config.line.channelAccessToken);
}

function isWhatsAppConfigured(config: AppConfig): boolean {
	return Boolean(
		config.whatsapp.accessToken &&
			config.whatsapp.phoneNumberId &&
			config.whatsapp.verifyToken &&
			config.whatsapp.appSecret,
	);
}
