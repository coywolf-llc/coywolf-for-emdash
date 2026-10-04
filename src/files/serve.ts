/**
 * Serves stable download URLs, /<base>/<id>/<filename>, through the pack
 * middleware. The file streams from R2 with Content-Disposition: attachment
 * (or redirects to a public bucket / CDN URL), with ETag, conditional
 * requests and byte ranges. Downloads are counted after the response.
 */
import { contentDisposition, downloadPath, parseDownloadPath } from "./format.js";
import { type ByteRange, ifRangeMatches, parseRange, resolveRange } from "./range.js";
import { type FileRecord, countDownload, readSiteSettings, resolveFile } from "./site.js";

export interface FilesSiteOptions {
	/** D1 binding of the site database. Default "DB". */
	database?: string;
	/** R2 binding of the media bucket. Default "MEDIA". */
	media?: string;
	/** R2 binding of the bucket large uploads go to. Default: FILES when bound, else the media bucket. */
	uploads?: string;
	/** Count downloads (the files.counts feature). */
	count?: boolean;
}

/** The R2 binding large uploads live in. */
export function uploadsBindingName(env: Record<string, unknown>, options: { media?: string; uploads?: string }): string {
	return options.uploads ?? (env.FILES ? "FILES" : (options.media ?? "MEDIA"));
}

const NOT_FOUND = () =>
	new Response("File not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

/** Whether a request should count as a download (not HEAD, not a later range chunk, not a 304). */
function countsAsDownload(request: Request, range: ByteRange | null): boolean {
	return request.method === "GET" && (!range || ("offset" in range && range.offset === 0));
}

export async function serveDownload(
	request: Request,
	url: URL,
	env: Record<string, unknown>,
	waitUntil: (p: Promise<unknown>) => void,
	options: FilesSiteOptions = {},
): Promise<Response | undefined> {
	if (request.method !== "GET" && request.method !== "HEAD") return undefined;
	if (url.pathname.startsWith("/_")) return undefined;
	const db = env[options.database ?? "DB"] as D1Database | undefined;
	if (!db) return undefined;

	const settings = await readSiteSettings(db);
	const parsed = parseDownloadPath(url.pathname, settings.base);
	if (!parsed) return undefined;

	const file = await resolveFile(db, parsed.id);
	if (!file) return NOT_FOUND();

	const canonical = downloadPath(settings.base, file.id, file.name);
	if (!parsed.filename) return Response.redirect(new URL(canonical, url).href, 301);

	if (settings.publicBaseUrl) {
		if (options.count && countsAsDownload(request, parseRange(request.headers.get("Range")))) countDownload(db, file.id, waitUntil);
		const target = `${settings.publicBaseUrl}/${file.key.split("/").map(encodeURIComponent).join("/")}`;
		return new Response(null, { status: 302, headers: { Location: target, "Cache-Control": "no-store" } });
	}

	const bucketName = file.source === "upload" ? uploadsBindingName(env, options) : (options.media ?? "MEDIA");
	const bucket = env[bucketName] as R2Bucket | undefined;
	if (!bucket) {
		console.error(`coywolf-pack files: R2 binding ${bucketName} is missing`);
		return NOT_FOUND();
	}
	const count = options.count ? () => countDownload(db, file.id, waitUntil) : () => undefined;
	return streamObject(request, bucket, file, count);
}

async function streamObject(request: Request, bucket: R2Bucket, file: FileRecord, count: () => void) {
	const headers = new Headers({
		"Content-Type": file.type || "application/octet-stream",
		"Content-Disposition": contentDisposition(file.name),
		"Accept-Ranges": "bytes",
		"Cache-Control": "public, max-age=0, must-revalidate",
		"X-Content-Type-Options": "nosniff",
	});

	if (request.method === "HEAD") {
		const head = await bucket.head(file.key);
		if (!head) return NOT_FOUND();
		headers.set("ETag", head.httpEtag);
		headers.set("Content-Length", String(head.size));
		headers.set("Last-Modified", head.uploaded.toUTCString());
		return new Response(null, { status: 200, headers });
	}

	// One range at most; several ranges or a malformed header get the whole file.
	let range = parseRange(request.headers.get("Range"));
	if (range && request.headers.has("If-Range")) {
		const head = await bucket.head(file.key);
		if (!head) return NOT_FOUND();
		if (!ifRangeMatches(request.headers.get("If-Range"), head.httpEtag, head.uploaded)) range = null;
	}

	let object: R2Object | R2ObjectBody | null;
	try {
		object = await bucket.get(file.key, {
			onlyIf: request.headers,
			...(range ? { range: "suffix" in range ? { suffix: range.suffix } : { offset: range.offset, ...(range.end !== undefined ? { length: range.end - range.offset + 1 } : {}) } } : {}),
		});
	} catch (error) {
		if (!range) throw error;
		if ("suffix" in range) {
			// A suffix longer than the file means the whole file (sent as a 206 of every byte).
			object = await bucket.get(file.key, { onlyIf: request.headers });
		} else {
			// R2 rejects a range that starts past the end.
			const head = await bucket.head(file.key);
			return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${head?.size ?? 0}` } });
		}
	}
	if (!object) return NOT_FOUND();
	headers.set("ETag", object.httpEtag);
	headers.set("Last-Modified", object.uploaded.toUTCString());

	// A precondition failed (If-None-Match matched, or If-Match didn't): R2 returns the object without a body.
	if (!("body" in object) || !object.body) {
		const matched = request.headers.has("If-None-Match") || request.headers.has("If-Modified-Since");
		return new Response(null, { status: matched ? 304 : 412, headers });
	}

	if (countsAsDownload(request, range)) count();

	const body = object as R2ObjectBody;
	if (range) {
		const bytes = resolveRange(range, body.size);
		if (!bytes) {
			await body.body.cancel();
			return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${body.size}` } });
		}
		headers.set("Content-Range", `bytes ${bytes.offset}-${bytes.offset + bytes.length - 1}/${body.size}`);
		headers.set("Content-Length", String(bytes.length));
		return new Response(body.body, { status: 206, headers });
	}
	headers.set("Content-Length", String(body.size));
	return new Response(body.body, { status: 200, headers });
}
