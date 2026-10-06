export type ForecastLocation = { latitude: number; longitude: number };

const locationHelp =
	"Discord ไม่ส่ง GPS/lat,lng มาให้อัตโนมัติครับ ระบุพิกัดใน message เช่น `ฝนจะถึงเมื่อไร 13.756,100.502` หรือใส่ทั้ง `latitude` และ `longitude` (รับลิงก์ Google Maps แบบเต็มที่มีพิกัดด้วย) ชื่อสถานที่หรือลิงก์สั้นอย่างเดียว ยังใช้ไม่ได้";

export function resolveForecastLocation(input: {
	message: string;
	latitude?: number;
	longitude?: number;
}): ForecastLocation {
	const candidates: ForecastLocation[] = [];
	if (input.latitude !== undefined || input.longitude !== undefined) {
		if (input.latitude === undefined || input.longitude === undefined) {
			throw new Error("กรุณาระบุ latitude และ longitude ให้ครบทั้งคู่");
		}
		candidates.push({ latitude: input.latitude, longitude: input.longitude });
	}
	// Only explicit coordinates; never infer GPS from Discord locale, IP or history.
	const coordinatePattern =
		/(?:^|[\s(])(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)(?=$|[\s)])/g;
	for (const match of input.message.matchAll(coordinatePattern)) {
		candidates.push({
			latitude: Number(match[1]),
			longitude: Number(match[2]),
		});
	}
	const labeled = input.message.match(
		/\blat(?:itude)?\s*[:=]\s*(-?\d+(?:\.\d+)?)\s*[,;\s]+(?:lng|lon|longitude)\s*[:=]\s*(-?\d+(?:\.\d+)?)/i,
	);
	if (labeled) {
		candidates.push({
			latitude: Number(labeled[1]),
			longitude: Number(labeled[2]),
		});
	}
	for (const match of input.message.matchAll(/https:\/\/[^\s<>]+/g)) {
		let url: URL;
		try {
			url = new URL(match[0]);
		} catch {
			continue;
		}
		if (
			![
				"www.google.com",
				"google.com",
				"maps.google.com",
				"www.google.co.th",
				"google.co.th",
			].includes(url.hostname) ||
			url.username ||
			url.password
		)
			continue;
		const query = url.searchParams.get("query") ?? url.searchParams.get("q");
		const pair = query?.match(/^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/);
		const pin = url.pathname.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
		const coordinates = pair ?? pin;
		if (coordinates)
			candidates.push({
				latitude: Number(coordinates[1]),
				longitude: Number(coordinates[2]),
			});
	}
	if (!candidates.length) throw new Error(locationHelp);
	for (const candidate of candidates) {
		if (
			!Number.isFinite(candidate.latitude) ||
			!Number.isFinite(candidate.longitude) ||
			Math.abs(candidate.latitude) > 85 ||
			Math.abs(candidate.longitude) > 180
		) {
			throw new Error(
				"พิกัดไม่ถูกต้อง: latitude ต้องอยู่ระหว่าง -85 ถึง 85 และ longitude ระหว่าง -180 ถึง 180",
			);
		}
	}
	const location = candidates[0]!;
	if (
		candidates.some(
			(candidate) =>
				Math.abs(candidate.latitude - location.latitude) > 0.000001 ||
				Math.abs(candidate.longitude - location.longitude) > 0.000001,
		)
	) {
		throw new Error("พบพิกัดมากกว่าหนึ่งจุดหรือพิกัดขัดกัน กรุณาระบุจุดเดียวที่ต้องการพยากรณ์");
	}
	return location;
}
