/**
 * AWS Signature Version 4 for the S3 API (Cloudflare R2), with Web Crypto
 * only, so the Worker bundle doesn't need the AWS SDK. Two forms:
 * header-signed requests (the Worker calling R2) and presigned URLs (the
 * browser uploading parts straight to R2). No imports, so `node --test` can
 * load this file directly.
 */

export interface SigV4Credentials {
	accessKeyId: string;
	secretAccessKey: string;
}

export interface SigV4Request {
	method: string;
	/** Host, e.g. "<account>.r2.cloudflarestorage.com". */
	host: string;
	/** Unencoded path, e.g. "/bucket/files/abc/report.pdf". Each segment is encoded here. */
	path: string;
	/** Query parameters (unencoded). Use "" for valueless ones such as `uploads` or `cors`. */
	query?: Record<string, string>;
	/** Extra headers to sign (host is added). */
	headers?: Record<string, string>;
	region: string;
	service?: string;
	/** Defaults to now. */
	date?: Date;
}

const encoder = new TextEncoder();
export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
export const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

function hex(buffer: ArrayBuffer): string {
	return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
	const bytes = typeof data === "string" ? encoder.encode(data) : data;
	return hex(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
	const cryptoKey = await crypto.subtle.importKey("raw", key as Uint8Array<ArrayBuffer>, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data));
}

/** S3's URI encoding: everything but A-Z a-z 0-9 - . _ ~ (and "/" when encoding a path). */
export function uriEncode(value: string, encodeSlash = true): string {
	let out = "";
	for (const byte of encoder.encode(value)) {
		const c = String.fromCharCode(byte);
		if (/[A-Za-z0-9\-._~]/.test(c) || (c === "/" && !encodeSlash)) out += c;
		else out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
	}
	return out;
}

export function canonicalQuery(query: Record<string, string> = {}): string {
	return Object.entries(query)
		.map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
		.sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
		.map(([k, v]) => `${k}=${v}`)
		.join("&");
}

/** "20130524T000000Z" */
export function amzDate(date: Date): string {
	return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

async function signingKey(secret: string, day: string, region: string, service: string): Promise<ArrayBuffer> {
	const kDate = await hmac(encoder.encode(`AWS4${secret}`), day);
	const kRegion = await hmac(kDate, region);
	const kService = await hmac(kRegion, service);
	return hmac(kService, "aws4_request");
}

interface Prepared {
	canonicalRequest: string;
	stringToSign: string;
	signature: string;
	signedHeaders: string;
	scope: string;
	datetime: string;
}

async function prepare(
	req: SigV4Request,
	creds: SigV4Credentials,
	headers: Record<string, string>,
	query: Record<string, string>,
	payloadHash: string,
	datetime: string,
): Promise<Prepared> {
	const service = req.service ?? "s3";
	const day = datetime.slice(0, 8);
	const scope = `${day}/${req.region}/${service}/aws4_request`;
	const lower = Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, " ")] as const);
	lower.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	const signedHeaders = lower.map(([k]) => k).join(";");
	const canonicalRequest = [
		req.method.toUpperCase(),
		uriEncode(req.path, false),
		canonicalQuery(query),
		lower.map(([k, v]) => `${k}:${v}\n`).join(""),
		signedHeaders,
		payloadHash,
	].join("\n");
	const stringToSign = ["AWS4-HMAC-SHA256", datetime, scope, await sha256Hex(canonicalRequest)].join("\n");
	const signature = hex(await hmac(await signingKey(creds.secretAccessKey, day, req.region, service), stringToSign));
	return { canonicalRequest, stringToSign, signature, signedHeaders, scope, datetime };
}

/**
 * Sign a request with an Authorization header. Returns the headers to send
 * (including host, x-amz-date and x-amz-content-sha256) and the full URL.
 */
export async function signRequest(
	req: SigV4Request,
	creds: SigV4Credentials,
	payloadHash: string = EMPTY_SHA256,
): Promise<{ url: string; headers: Record<string, string>; signature: string }> {
	const datetime = amzDate(req.date ?? new Date());
	const headers: Record<string, string> = {
		...req.headers,
		host: req.host,
		"x-amz-date": datetime,
		"x-amz-content-sha256": payloadHash,
	};
	const query = req.query ?? {};
	const p = await prepare(req, creds, headers, query, payloadHash, datetime);
	const out = { ...headers };
	delete out.host; // fetch sets Host itself.
	out.authorization = `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${p.scope},SignedHeaders=${p.signedHeaders},Signature=${p.signature}`;
	const qs = canonicalQuery(query);
	return { url: `https://${req.host}${uriEncode(req.path, false)}${qs ? `?${qs}` : ""}`, headers: out, signature: p.signature };
}

/** A presigned URL (query-string auth, unsigned payload). Only `host` is signed unless `headers` adds more. */
export async function presignUrl(req: SigV4Request, creds: SigV4Credentials, expiresSeconds: number): Promise<{ url: string; signature: string }> {
	const datetime = amzDate(req.date ?? new Date());
	const service = req.service ?? "s3";
	const headers: Record<string, string> = { ...req.headers, host: req.host };
	const signedHeaders = Object.keys(headers)
		.map((k) => k.toLowerCase())
		.sort()
		.join(";");
	const query: Record<string, string> = {
		...req.query,
		"X-Amz-Algorithm": "AWS4-HMAC-SHA256",
		"X-Amz-Credential": `${creds.accessKeyId}/${datetime.slice(0, 8)}/${req.region}/${service}/aws4_request`,
		"X-Amz-Date": datetime,
		"X-Amz-Expires": String(Math.max(1, Math.min(604800, Math.floor(expiresSeconds)))),
		"X-Amz-SignedHeaders": signedHeaders,
	};
	const p = await prepare(req, creds, headers, query, UNSIGNED_PAYLOAD, datetime);
	const qs = `${canonicalQuery(query)}&X-Amz-Signature=${p.signature}`;
	return { url: `https://${req.host}${uriEncode(req.path, false)}?${qs}`, signature: p.signature };
}
