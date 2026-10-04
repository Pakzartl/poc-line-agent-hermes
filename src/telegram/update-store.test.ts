import { describe, expect, test } from "bun:test";
import {
	createKvTelegramUpdateStore,
	createPassThroughTelegramUpdateStore,
} from "./update-store";

describe("Telegram update store", () => {
	test("claims, completes, and releases updates with bounded TTLs", async () => {
		const values = new Map<string, string>();
		const writes: { key: string; value: string; expirationTtl: number }[] = [];
		const deletes: string[] = [];
		const store = createKvTelegramUpdateStore({
			get: async (key) => values.get(key) ?? null,
			put: async (key, value, options) => {
				values.set(key, value);
				writes.push({ key, value, expirationTtl: options.expirationTtl });
			},
			delete: async (key) => {
				values.delete(key);
				deletes.push(key);
			},
		});

		const claim = claimInput("telegram:update:12345");

		expect(await store.claim(claim)).toMatchObject({ claimed: true });
		expect(await store.claim(claim)).toMatchObject({ duplicate: true });
		await store.complete(claim);
		await store.release(claim);
		expect(await store.claim(claim)).toMatchObject({ claimed: true });
		expect(writes.map((write) => write.key)).toEqual([
			"telegram:update:12345",
			"telegram:update:12345",
			"telegram:update:12345",
		]);
		expect(writes.map((write) => write.expirationTtl)).toEqual([
			3_600, 86_400, 3_600,
		]);
		expect(deletes).toEqual(["telegram:update:12345"]);
	});

	test("pass-through store still issues a lease for local unit tests", async () => {
		const store = createPassThroughTelegramUpdateStore();
		const claim = await store.claim(claimInput("telegram:update:1"));
		const lease = await store.dispatchLease({
			...claimInput("telegram:update:1"),
			sessionSequence: claim.record?.sessionSequence,
			generation: claim.record?.generation,
		});

		expect(claim.claimed).toBe(true);
		expect(lease.kind).toBe("leased");
	});
});

function claimInput(idempotencyKey: string) {
	return {
		providerSessionId: "telegram:chat:9001",
		idempotencyKey,
		canonicalInputHash: "hash",
	};
}
