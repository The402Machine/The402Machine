import { isIP } from "node:net";

import geoip from "fast-geoip";

import type { CatchIpLocation } from "./storage/catch-repository.js";

export async function lookupIpLocally(ip: string): Promise<CatchIpLocation | undefined> {
	if (isIP(ip) !== 4 || isNonPublicIpv4(ip)) return undefined;
	const location = await geoip.lookup(ip);
	if (location === null) return undefined;
	return {
		ip,
		country: location.country,
		city: location.city,
		continent: "",
		latitude: location.ll[0],
		longitude: location.ll[1],
		timeZone: location.timezone,
		source: "GeoLite2 (local)",
	};
}

function isNonPublicIpv4(ip: string): boolean {
	const [a, b = 0, c = 0] = ip.split(".").map(Number);
	return a === undefined || a === 0 || a === 10 || a === 127 || a >= 224 ||
		(a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 0 && c === 0) ||
		(a === 192 && b === 0 && c === 2) || (a === 192 && b === 168) ||
		(a === 198 && (b === 18 || b === 19 || b === 51)) ||
		(a === 203 && b === 0 && c === 113);
}
