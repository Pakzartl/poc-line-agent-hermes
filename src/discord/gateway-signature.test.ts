import { describe, expect, test } from "bun:test";
import {
	createDiscordGatewaySignature,
	verifyDiscordGatewayRequest,
} from "./gateway-signature";

describe("Discord Gateway bridge signature", () => {
	test("accepts a current valid HMAC and rejects tampering or stale requests", () => {
		const now = Date.now();
		const timestamp = String(Math.floor(now / 1_000));
		const body = JSON.stringify({ type: "message_create" });
		const sharedSecret = "s".repeat(32);
		const signature = createDiscordGatewaySignature(
			body,
			timestamp,
			sharedSecret,
		);

		expect(
			verifyDiscordGatewayRequest({
				body,
				timestamp,
				signature,
				sharedSecret,
				now,
			}),
		).toBe(true);
		expect(
			verifyDiscordGatewayRequest({
				body: `${body} `,
				timestamp,
				signature,
				sharedSecret,
				now,
			}),
		).toBe(false);
		expect(
			verifyDiscordGatewayRequest({
				body,
				timestamp: String(Math.floor(now / 1_000) - 301),
				signature,
				sharedSecret,
				now,
			}),
		).toBe(false);
	});
});
