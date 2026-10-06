import { decodePng, type PngImage } from "./png";

const API = "https://api.rainviewer.com/public/weather-maps.json";
const TILES = "https://tilecache.rainviewer.com";
const SIDE = 64;
const STEP = 4;
// Universal Blue rain >= 20 dBZ, from RainViewer's official RGBA CSV.
// No conversion to mm/h: rendered reflectivity is not a rain-gauge measurement.
const RAIN_COLORS = new Set(
	"00a3e0 009ad5 0091ca 0088bf 007fb4 0077aa 0070a3 00699c 006295 005b8e 005588 005180 004e78 004a70 004768 ffee00 ffe000 ffd200 ffc500 ffb700 ffaa00 ff9f00 ff9500 ff8b00 ff8100 ff4400 f23600 e62800 d91b00 cd0d00 c10000 a80000 8f0000 760000 5d0000 ffaaff ff9fff ff95ff ff8bff ff81ff ff77ff ff6cff ff62ff ff58ff ff4eff ffffff 00ff00"
		.split(" ")
		.map((color) => Number.parseInt(color, 16)),
);

interface Frame {
	time: number;
	path: string;
}
interface Motion {
	dx: number;
	dy: number;
	score: number;
	matches: number;
	margin: number;
}

async function readBounded(
	response: Response,
	max: number,
): Promise<Uint8Array> {
	if (!response.ok || !response.body)
		throw new Error("Radar provider unavailable");
	if (Number(response.headers.get("content-length")) > max)
		throw new Error("Radar response too large");
	const reader = response.body.getReader();
	const parts: Uint8Array[] = [];
	let length = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			length += value.length;
			if (length > max) throw new Error("Radar response too large");
			parts.push(value);
		}
	} finally {
		await reader.cancel();
	}
	const result = new Uint8Array(length);
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.length;
	}
	return result;
}

type RadarFetch = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

async function getBytes(
	url: string,
	fetcher: RadarFetch,
	max: number,
): Promise<Uint8Array> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 8000);
	try {
		const response = await fetcher(url, {
			signal: controller.signal,
			redirect: "error",
		});
		return await readBounded(response, max);
	} finally {
		clearTimeout(timer);
	}
}

function framesFrom(raw: unknown): Frame[] {
	if (!raw || typeof raw !== "object")
		throw new Error("Invalid radar manifest");
	const radar = (raw as { radar?: { past?: unknown } }).radar;
	if (
		!Array.isArray(radar?.past) ||
		radar.past.length < 3 ||
		radar.past.length > 100
	)
		throw new Error("Not enough radar frames");
	// Ignore host supplied by the API. Every image request uses our fixed allowlisted host.
	const frames: Frame[] = radar.past
		.map((f: unknown) => {
			if (!f || typeof f !== "object") throw new Error("Invalid radar frame");
			const { time, path } = f as Partial<Frame>;
			if (
				!Number.isSafeInteger(time) ||
				typeof time !== "number" ||
				time <= 0 ||
				typeof path !== "string" ||
				!/^\/v2\/radar\/[a-zA-Z0-9_-]{1,80}$/.test(path)
			)
				throw new Error("Invalid radar frame");
			return { time, path };
		})
		.sort((a, b) => a.time - b.time);
	return frames.slice(-3);
}

function checkTile(image: PngImage): void {
	if (image.width !== 256 || image.height !== 256)
		throw new Error("Unexpected radar tile size");
}

function covered(image: PngImage): boolean {
	checkTile(image);
	// A transparent coverage pixel means covered; opaque black means no data.
	// Require the complete motion-analysis window, not just the target, to be covered.
	for (let i = 3; i < image.rgba.length; i += 4)
		if (image.rgba[i]! > 16) return false;
	return true;
}

function rainMask(image: PngImage): Uint8Array {
	checkTile(image);
	const mask = new Uint8Array(SIDE * SIDE);
	for (let gy = 0; gy < SIDE; gy++)
		for (let gx = 0; gx < SIDE; gx++) {
			let count = 0;
			for (let y = gy * STEP; y < (gy + 1) * STEP; y++)
				for (let x = gx * STEP; x < (gx + 1) * STEP; x++) {
					const i = (y * 256 + x) * 4;
					const color =
						(image.rgba[i]! << 16) |
						(image.rgba[i + 1]! << 8) |
						image.rgba[i + 2]!;
					if (image.rgba[i + 3] === 255 && RAIN_COLORS.has(color)) count++;
				}
			mask[gy * SIDE + gx] = count >= 4 ? 1 : 0;
		}
	return mask;
}

/** Global translation only: intentionally conservative, not a calibrated forecast model. */
export function estimateRadarMotion(
	before: Uint8Array,
	after: Uint8Array,
): Motion | undefined {
	if (before.length !== SIDE * SIDE || after.length !== SIDE * SIDE)
		return undefined;
	const candidates: Motion[] = [];
	for (let dy = -3; dy <= 3; dy++)
		for (let dx = -3; dx <= 3; dx++) {
			let countBefore = 0,
				countAfter = 0,
				matches = 0;
			// Fixed interior excludes edge entry/exit and keeps candidate scores comparable.
			for (let y = 4; y < SIDE - 4; y++)
				for (let x = 4; x < SIDE - 4; x++) {
					const a = before[y * SIDE + x]!;
					const b = after[(y + dy) * SIDE + x + dx]!;
					countBefore += a;
					countAfter += b;
					matches += a && b ? 1 : 0;
				}
			const score =
				countBefore + countAfter
					? (2 * matches) / (countBefore + countAfter)
					: 0;
			candidates.push({ dx, dy, score, matches, margin: 0 });
		}
	candidates.sort((a, b) => b.score - a.score);
	const best = candidates[0]!;
	best.margin = best.score - candidates[1]!.score;
	if (best.matches < 12 || best.score < 0.75 || best.margin < 0.025)
		return undefined;
	return best;
}

function nearTarget(mask: Uint8Array, dx = 0, dy = 0): boolean {
	for (let y = 0; y < SIDE; y++)
		for (let x = 0; x < SIDE; x++)
			if (
				mask[y * SIDE + x] &&
				Math.hypot(x + 0.5 + dx - SIDE / 2, y + 0.5 + dy - SIDE / 2) <= 1.5
			)
				return true;
	return false;
}

export async function forecastRadar(
	input: { latitude: number; longitude: number },
	deps: { fetch?: RadarFetch; now?: () => number } = {},
): Promise<{ text: string; data: unknown }> {
	const { latitude, longitude } = input;
	if (
		!Number.isFinite(latitude) ||
		latitude < -85 ||
		latitude > 85 ||
		!Number.isFinite(longitude) ||
		longitude < -180 ||
		longitude > 180
	)
		return {
			text: "พิกัดไม่ถูกต้อง กรุณาระบุ latitude -85 ถึง 85 และ longitude -180 ถึง 180",
			data: { status: "invalid_location" },
		};
	const fetcher = deps.fetch ?? fetch;
	const now = (deps.now ?? Date.now)() / 1000;
	const metadata: Record<string, unknown> = {
		latitude,
		longitude,
		source: "RainViewer",
		experimental: true,
	};
	const finish = (status: string, message: string) => ({
		text: `${message}\n\nพิกัด: ${latitude}, ${longitude}${typeof metadata.frameTime === "number" ? `\nเวลา composite: ${new Date(metadata.frameTime * 1000).toISOString()} (ไม่ใช่เวลาตรวจของทุกสถานี)` : ""}\n\nเป็นการทดลองจากภาพเรดาร์ ไม่ใช่การรับรองฝนที่จุดนั้น การเกิด/สลายตัวของกลุ่มฝนอาจเปลี่ยนผลได้\nแหล่งข้อมูล: RainViewer — https://www.rainviewer.com/`,
		data: { ...metadata, status },
	});
	try {
		const frames = framesFrom(
			JSON.parse(
				new TextDecoder().decode(await getBytes(API, fetcher, 100_000)),
			),
		);
		const [first, middle, latest] = frames as [Frame, Frame, Frame];
		metadata.frameTime = latest.time;
		const age = now - latest.time;
		const interval1 = middle.time - first.time;
		const interval2 = latest.time - middle.time;
		if (
			age < -60 ||
			age > 1200 ||
			interval1 < 300 ||
			interval1 > 900 ||
			interval2 < 300 ||
			interval2 > 900 ||
			Math.abs(interval1 - interval2) > 60
		)
			return finish(
				"stale",
				"ข้อมูลเรดาร์เก่า เวลาผิดปกติ หรือภาพต่อเนื่องไม่ครบ จึงยังประเมินฝนไม่ได้ (ไม่ใช่ไม่มีฝน)",
			);
		const location = `/256/7/${latitude}/${longitude}`;
		const urls = [
			`${TILES}/v2/coverage/0${location}/0/0_0.png`,
			...frames.map((frame) => `${TILES}${frame.path}${location}/2/0_0.png`),
		];
		const images = await Promise.all(
			urls.map(async (url) =>
				decodePng(await getBytes(url, fetcher, 2_000_000)),
			),
		);
		if (!covered(images[0]!))
			return finish(
				"no_coverage",
				"เรดาร์ไม่ครอบคลุมจุดนี้หรือพื้นที่ที่ต้องใช้ติดตามกลุ่มฝนครบ จึงยังประเมินไม่ได้ (ไม่ใช่ไม่มีฝน)",
			);
		const masks = images.slice(1).map(rainMask);
		const current = masks[2]!;
		const kmPerCell =
			((40075.016686 * Math.cos((latitude * Math.PI) / 180)) / (2 ** 7 * 256)) *
			STEP;
		const radius = Math.round(kmPerCell * 1.5 * 10) / 10;
		metadata.radiusKm = radius;
		metadata.thresholdDbz = 20;
		if (nearTarget(current))
			return finish(
				"nearby_echo",
				`พบสัญญาณสะท้อนเรดาร์ ≥20 dBZ ใกล้พิกัดในภาพล่าสุด ภายในรัศมีประมาณ ${radius} กม. ไม่สามารถยืนยันว่าฝนตกที่พิกัดจริงจากภาพนี้อย่างเดียว`,
			);
		if (!current.some((pixel) => pixel))
			return finish(
				"no_echo",
				"ภาพล่าสุดยังไม่พบสัญญาณสะท้อน ≥20 dBZ ในพื้นที่วิเคราะห์ แต่ไม่ได้แปลว่าจะไม่มีฝนหรือฝนจะไม่ก่อตัวใหม่ จึงไม่ระบุเวลาเริ่มตก",
			);
		const a = estimateRadarMotion(masks[0]!, masks[1]!);
		const b = estimateRadarMotion(masks[1]!, current);
		if (
			!a ||
			!b ||
			Math.hypot(
				a.dx / interval1 - b.dx / interval2,
				a.dy / interval1 - b.dy / interval2,
			) *
				interval2 >
				1
		)
			return finish(
				"uncertain",
				"พบกลุ่มฝน แต่ทิศทาง/ความเร็วหรือความต่อเนื่องของภาพไม่ชัดเจน จึงยังระบุเวลาที่ฝนจะเข้าจุดนี้ไม่ได้",
			);
		const vx = (a.dx / interval1 + b.dx / interval2) / 2;
		const vy = (a.dy / interval1 + b.dy / interval2) / 2;
		const speed = Math.hypot(vx, vy) * kmPerCell * 3600;
		metadata.motionScore = Math.min(a.score, b.score);
		metadata.speedKmh = Math.round(speed);
		if (speed < 3 || speed > 100)
			return finish(
				"uncertain",
				"กลุ่มฝนหยุดนิ่งหรือความเร็วที่คำนวณได้ไม่น่าเชื่อถือ จึงยังระบุเวลาฝนเข้าพื้นที่ไม่ได้",
			);
		for (let minutes = 0; minutes <= 30; minutes += 5) {
			const lead = Math.max(age, 0) + minutes * 60;
			if (nearTarget(current, vx * lead, vy * lead)) {
				const low = Math.max(0, minutes - 5),
					high = Math.min(30, minutes + 5);
				metadata.arrivalWindowMinutes = [low, high];
				return finish(
					"estimated_arrival",
					`ทดลองประเมิน: ถ้ากลุ่มฝนยังเคลื่อนที่เหมือน 3 ภาพล่าสุด สัญญาณฝนอาจเข้าพื้นที่รัศมีประมาณ ${radius} กม. รอบพิกัดในอีก ${low}–${high} นาที\nนี่คือการเลื่อนภาพกลุ่มฝนตามความเร็วเดิม ไม่ใช่โอกาสฝนที่ผ่านการสอบเทียบ และยังไม่ได้ทดสอบความแม่นยำในพื้นที่คุณ`,
				);
			}
		}
		return finish(
			"no_estimated_arrival",
			"ยังไม่พบกลุ่มฝนที่แบบจำลองการเลื่อนภาพคาดว่าจะเข้าพื้นที่ใน 30 นาที แต่ไม่รับรองว่าจะไม่มีฝน โดยเฉพาะฝนที่ก่อตัวใหม่",
		);
	} catch {
		return finish(
			"unavailable",
			"ดึงหรืออ่านข้อมูลเรดาร์ไม่ได้ จึงยังประเมินฝนไม่ได้ (ไม่ใช่ไม่มีฝน) กรุณาลองใหม่ภายหลัง",
		);
	}
}
