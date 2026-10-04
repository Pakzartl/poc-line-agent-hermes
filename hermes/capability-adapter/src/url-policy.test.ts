import { describe, expect, test } from "bun:test";
import { assertPublicDnsResolution } from "./url-policy";

describe("capability adapter DNS policy", () => {
	test("accepts only resolutions whose addresses are all public", async () => {
		await expect(
			assertPublicDnsResolution(new URL("https://example.com"), async () => [
				{ address: "93.184.216.34", family: 4 },
			]),
		).resolves.toEqual(["93.184.216.34"]);
		await expect(
			assertPublicDnsResolution(new URL("https://example.com"), async () => [
				{ address: "127.0.0.1", family: 4 },
			]),
		).rejects.toThrow("non-public address");
		await expect(
			assertPublicDnsResolution(new URL("https://example.com"), async () => [
				{ address: "::ffff:127.0.0.1", family: 6 },
			]),
		).rejects.toThrow("non-public address");
	});
});
