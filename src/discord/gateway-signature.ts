import { createHmac, timingSafeEqual } from "node:crypto";

const maxTimestampSkewSeconds = 300;

export function createDiscordGatewaySignature(
	body: string,
	timestamp: string,
	sharedSecret: string,
): string {
	return createHmac("sha256", sharedSecret)
		.update(`${timestamp}.${body}`)
		.digest("hex");
}

export function verifyDiscordGatewayRequest(input: {
	body: string;
	timestamp: string | null;
	signature: string | null;
	sharedSecret: string;
	now?: number;
}): boolean {
	if (!input.sharedSecret || !input.timestamp || !input.signature) {
		return false;
	}
	if (!/^\d{10}$/.test(input.timestamp)) {
		return false;
	}
	if (!/^[0-9a-f]{64}$/i.test(input.signature)) {
		return false;
	}
	const timestampSeconds = Number(input.timestamp);
	const nowSeconds = Math.floor((input.now ?? Date.now()) / 1_000);
	if (Math.abs(nowSeconds - timestampSeconds) > maxTimestampSkewSeconds) {
		return false;
	}
	const expected = Buffer.from(
		createDiscordGatewaySignature(
			input.body,
			input.timestamp,
			input.sharedSecret,
		),
	);
	const received = Buffer.from(input.signature.toLowerCase());
	return (
		expected.byteLength === received.byteLength &&
		timingSafeEqual(expected, received)
	);
}
