/**
 * Backup downloads. Plugin routes can only answer with a body held in memory,
 * and a database dump can be larger than a Worker should buffer, so the
 * Backups page asks the backups/download-link route (admins only) for a
 * short-lived link, and the pack middleware streams the file from R2 at that
 * link:
 *
 *   /_coywolf-pack/backup/<token>/<file name>
 *
 * The token is random (192 bits) and names a ticket in the backup bucket,
 * downloads/<token>.json, that says which file it opens and until when. A
 * ticket works for ten minutes (so a browser can retry or resume), and old
 * tickets are deleted whenever a new one is made.
 */
import { contentDisposition } from "../files/format.js";
import { FILE, STAMP } from "./store.js";

export const DOWNLOAD_PATH = "/_coywolf-pack/backup/";
const TICKET_PREFIX = "downloads/";
const TICKET_TTL_MS = 10 * 60_000;
const TOKEN = /^[a-f0-9]{48}$/;

interface Ticket {
	key: string;
	filename: string;
	expires: string;
}

/** Set by backupsPack() when the module is configured; the middleware does nothing without it. */
let config: { backups: string } | null = null;

export function configureBackupDownloads(options: { backups?: string }) {
	config = { backups: options.backups ?? "BACKUPS" };
}

function newToken(): string {
	return [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The file name a download is saved as: mysite-2026-10-03T1802Z.sql.gz. */
export function downloadFilename(file: string, stamp: string): string {
	const match = /^(.*?)(\.sql\.gz|\.gz|\.sql)?$/i.exec(file);
	return `${match?.[1] || "database"}-${stamp}${match?.[2] ?? ""}`;
}

/** Delete tickets that have expired (by upload time, so no ticket has to be read). */
async function pruneTickets(bucket: R2Bucket) {
	const cutoff = Date.now() - TICKET_TTL_MS;
	let cursor: string | undefined;
	do {
		const page = await bucket.list({ prefix: TICKET_PREFIX, cursor });
		const old = page.objects.filter((o) => o.uploaded.getTime() < cutoff).map((o) => o.key);
		if (old.length) await bucket.delete(old);
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
}

/** Make a download link for one backup file, or null when it doesn't exist. */
export async function createDownloadLink(bucket: R2Bucket, stamp: string, file: string): Promise<{ url: string; filename: string; bytes: number; expires: string } | null> {
	if (!STAMP.test(stamp) || !FILE.test(file)) return null;
	const key = `d1/${stamp}/${file}`;
	const head = await bucket.head(key);
	if (!head) return null;
	await pruneTickets(bucket).catch(() => undefined);
	const token = newToken();
	const filename = downloadFilename(file, stamp);
	const ticket: Ticket = { key, filename, expires: new Date(Date.now() + TICKET_TTL_MS).toISOString() };
	await bucket.put(`${TICKET_PREFIX}${token}.json`, JSON.stringify(ticket), { httpMetadata: { contentType: "application/json" } });
	return { url: `${DOWNLOAD_PATH}${token}/${encodeURIComponent(filename)}`, filename, bytes: head.size, expires: ticket.expires };
}

const NOT_FOUND = () =>
	new Response("This download link has expired. Download the backup again from the Backups page.", {
		status: 404,
		headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
	});

/** Middleware: stream a backup file for a valid ticket. Returns undefined for any other URL. */
export async function serveBackupDownload(request: Request, url: URL, env: Record<string, unknown>): Promise<Response | undefined> {
	if (!config || !url.pathname.startsWith(DOWNLOAD_PATH)) return undefined;
	if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
	const token = url.pathname.slice(DOWNLOAD_PATH.length).split("/")[0];
	if (!TOKEN.test(token)) return NOT_FOUND();
	const bucket = env[config.backups] as R2Bucket | undefined;
	if (!bucket) return NOT_FOUND();

	const ticketObject = await bucket.get(`${TICKET_PREFIX}${token}.json`);
	if (!ticketObject) return NOT_FOUND();
	const ticket = (await ticketObject.json()) as Ticket;
	if (!(Date.parse(ticket.expires) > Date.now()) || !ticket.key.startsWith("d1/")) return NOT_FOUND();

	const headers = new Headers({
		"Content-Type": "application/gzip",
		"Content-Disposition": contentDisposition(ticket.filename),
		"Cache-Control": "private, no-store",
		"Referrer-Policy": "no-referrer",
		"X-Content-Type-Options": "nosniff",
		"X-Robots-Tag": "noindex",
	});
	if (request.method === "HEAD") {
		const head = await bucket.head(ticket.key);
		if (!head) return NOT_FOUND();
		headers.set("Content-Length", String(head.size));
		return new Response(null, { headers });
	}
	const object = await bucket.get(ticket.key);
	if (!object) return NOT_FOUND();
	headers.set("Content-Length", String(object.size));
	headers.set("ETag", object.httpEtag);
	// Streamed straight from R2: the Worker never holds the whole file.
	return new Response(object.body, { headers });
}
