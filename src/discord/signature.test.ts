import { describe, expect, test } from "bun:test";
import { verifyDiscordRequest } from "./signature";

describe("Discord request verification", () => {
	test("accepts the exact signed timestamp and body", async () => {
		const fixture = await signedFixture('{"type":1}');

		expect(await verifyDiscordRequest(fixture)).toBe(true);
		expect(await verifyDiscordRequest({ ...fixture, body: '{"type":2}' })).toBe(
			false,
		);
	});

	test("rejects malformed headers without throwing", async () => {
		expect(
			await verifyDiscordRequest({
				body: "{}",
				publicKey: "nope",
				signature: "bad",
				timestamp: "1",
			}),
		).toBe(false);
	});
});

async function signedFixture(body: string) {
	const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
		"sign",
		"verify",
	]);
	const publicKey = new Uint8Array(
		await crypto.subtle.exportKey("raw", keyPair.publicKey),
	);
	const timestamp = "1720000000";
	const signature = new Uint8Array(
		await crypto.subtle.sign(
			{ name: "Ed25519" },
			keyPair.privateKey,
			new TextEncoder().encode(`${timestamp}${body}`),
		),
	);
	return {
		body,
		publicKey: toHex(publicKey),
		signature: toHex(signature),
		timestamp,
	};
}

function toHex(bytes: Uint8Array): string {
	return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
