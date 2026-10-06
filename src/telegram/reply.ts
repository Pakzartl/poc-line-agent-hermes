import { formatTelegramMessage, limitTelegramText } from "./format";

type FetchLike = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

export type TelegramInlineKeyboardMarkup = {
	inline_keyboard: readonly (readonly {
		text: string;
		callback_data: string;
	}[])[];
};

export type TelegramReplyClient = {
	reply(
		chatId: number | string,
		text: string,
		messageId?: number,
		options?: { replyMarkup?: TelegramInlineKeyboardMarkup },
	): Promise<void>;
	sendChatAction?(chatId: number | string, action?: "typing"): Promise<void>;
	answerCallbackQuery?(callbackQueryId: string, text?: string): Promise<void>;
};

export function createTelegramReplyClient(options: {
	botToken: string;
	apiBaseUrl?: string;
	fetch?: FetchLike;
}): TelegramReplyClient {
	const fetchImpl = options.fetch ?? fetch;
	const apiBaseUrl = options.apiBaseUrl ?? "https://api.telegram.org";

	return {
		async sendChatAction(chatId, action = "typing") {
			if (!options.botToken) {
				throw new Error("TELEGRAM_BOT_TOKEN is required");
			}
			const response = await fetchImpl(
				`${apiBaseUrl}/bot${options.botToken}/sendChatAction`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ chat_id: chatId, action }),
				},
			);
			if (!response.ok) {
				throw new Error(
					`Telegram chat action failed with status ${response.status}`,
				);
			}
		},
		async reply(chatId, text, messageId, replyOptions) {
			if (!options.botToken) {
				throw new Error("TELEGRAM_BOT_TOKEN is required");
			}

			const message = formatTelegramMessage(text);
			let response = await sendMessage(message.html, "HTML");
			if (response.status === 400) {
				response = await sendMessage(message.plainText);
			}

			if (!response.ok) {
				throw new Error(`Telegram reply failed with status ${response.status}`);
			}

			async function sendMessage(
				messageText: string,
				parseMode?: "HTML",
			): Promise<Response> {
				return fetchImpl(`${apiBaseUrl}/bot${options.botToken}/sendMessage`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						chat_id: chatId,
						text: messageText,
						...(parseMode ? { parse_mode: parseMode } : {}),
						...(replyOptions?.replyMarkup
							? { reply_markup: replyOptions.replyMarkup }
							: {}),
						...(messageId
							? { reply_parameters: { message_id: messageId } }
							: {}),
					}),
				});
			}
		},
		async answerCallbackQuery(callbackQueryId, text) {
			if (!options.botToken) {
				throw new Error("TELEGRAM_BOT_TOKEN is required");
			}
			const response = await fetchImpl(
				`${apiBaseUrl}/bot${options.botToken}/answerCallbackQuery`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						callback_query_id: callbackQueryId,
						...(text ? { text } : {}),
					}),
				},
			);
			if (!response.ok) {
				throw new Error(
					`Telegram callback answer failed with status ${response.status}`,
				);
			}
		},
	};
}

export { limitTelegramText };
