import QRCode from "qrcode";

export function renderQr(invoice) {
	if (typeof invoice !== "string" || invoice.length === 0 || invoice.length > 8_000) throw new Error("Invalid Lightning invoice");
	const qr = QRCode.create(invoice.toUpperCase(), { errorCorrectionLevel: "M" });
	const size = qr.modules.size;
	const quiet = 4;
	const viewBox = size + quiet * 2;
	const scale = 8;
	let pixels = "";
	for (let row = 0; row < size; row += 1) {
		for (let column = 0; column < size; column += 1) {
			if (qr.modules.get(row, column)) pixels += `<rect x="${(column + quiet) * scale}" y="${(row + quiet) * scale}" width="${scale}" height="${scale}" fill="#000"/>`;
		}
	}
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewBox * scale} ${viewBox * scale}" role="img" aria-label="Lightning invoice QR code" shape-rendering="crispEdges" style="color-scheme:only light;forced-color-adjust:none;background:#fff"><rect width="100%" height="100%" fill="#fff" style="fill:#fff"/>${pixels}</svg>`;
}
