/**
 * Site-side reads and writes for File Downloads, outside the plugin context
 * (the download middleware and the Astro download card). They go straight to
 * D1: plugin settings live in `options`, large uploads and download counts in
 * `_plugin_storage`, media library files in `media`. Reads are cached per
 * isolate; download counts are batched and written after the response.
 */
import { PLUGIN_ID } from "../core/features.js";
import { createDownloadCounter } from "./counts.js";
import { isUploadId, normalizeBase, safeColor } from "./format.js";

export const COLLECTIONS = {
	uploads: "files_uploads",
	usage: "files_usage",
	counts: "files_counts",
} as const;

/** Site settings the card and downloads need (never the S3 credentials). */
export interface SiteSettings {
	base: string;
	publicBaseUrl: string;
	scheme: "auto" | "light" | "dark";
	accent: string;
}

/** A downloadable file, from either store. */
export interface FileRecord {
	id: string;
	source: "upload" | "media";
	name: string;
	type: string;
	size: number;
	uploadedAt: string;
	key: string;
}

/** Large-upload metadata in plugin storage. */
export interface UploadDoc {
	id: string;
	key: string;
	name: string;
	size: number;
	type: string;
	uploadedAt: string;
	status: "uploading" | "ready";
	uploadId?: string;
	partSize?: number;
}

const SETTING_KEYS = ["filesBase", "filesPublicBaseUrl", "filesScheme", "filesAccent"] as const;
const SETTINGS_TTL = 30_000;
const FILE_TTL = 60_000;
const FILE_CACHE_MAX = 500;

let settingsCache: { value: SiteSettings; at: number } | null = null;
const fileCache = new Map<string, { value: FileRecord | null; at: number }>();

/** Forget cached settings and files (after admin changes in this isolate). */
export function invalidateSiteCache(id?: string): void {
	settingsCache = null;
	if (id) fileCache.delete(id);
	else fileCache.clear();
}

export function settingsFrom(raw: Record<string, unknown>): SiteSettings {
	const scheme = raw.filesScheme === "light" || raw.filesScheme === "dark" ? raw.filesScheme : "auto";
	const publicBase = typeof raw.filesPublicBaseUrl === "string" ? raw.filesPublicBaseUrl.trim().replace(/\/+$/, "") : "";
	return {
		base: normalizeBase(raw.filesBase),
		publicBaseUrl: /^https:\/\/[^\s"'<>]+$/i.test(publicBase) ? publicBase : "",
		scheme,
		accent: safeColor(raw.filesAccent),
	};
}

export async function readSiteSettings(db: D1Database): Promise<SiteSettings> {
	if (settingsCache && Date.now() - settingsCache.at < SETTINGS_TTL) return settingsCache.value;
	const raw: Record<string, unknown> = {};
	try {
		const names = SETTING_KEYS.map((k) => `plugin:${PLUGIN_ID}:settings:${k}`);
		const { results } = await db
			.prepare(`SELECT name, value FROM options WHERE name IN (${names.map(() => "?").join(",")})`)
			.bind(...names)
			.all<{ name: string; value: string }>();
		for (const row of results ?? []) {
			try {
				raw[row.name.slice(row.name.lastIndexOf(":") + 1)] = JSON.parse(row.value);
			} catch {
				// Ignore an unreadable value; the default applies.
			}
		}
	} catch (error) {
		console.error("coywolf-pack files: could not read settings", error);
	}
	const value = settingsFrom(raw);
	settingsCache = { value, at: Date.now() };
	return value;
}

export function uploadToRecord(doc: UploadDoc): FileRecord {
	return { id: doc.id, source: "upload", name: doc.name, type: doc.type, size: doc.size, uploadedAt: doc.uploadedAt, key: doc.key };
}

/** Look up a file by id: a ready large upload, or a ready media library item. Null when missing. */
export async function resolveFile(db: D1Database, id: string): Promise<FileRecord | null> {
	const hit = fileCache.get(id);
	if (hit && Date.now() - hit.at < FILE_TTL) return hit.value;
	let value: FileRecord | null = null;
	if (isUploadId(id)) {
		const row = await db
			.prepare("SELECT data FROM _plugin_storage WHERE plugin_id = ? AND collection = ? AND id = ?")
			.bind(PLUGIN_ID, COLLECTIONS.uploads, id)
			.first<{ data: string }>();
		const doc = row ? (JSON.parse(row.data) as UploadDoc) : null;
		value = doc && doc.status === "ready" ? uploadToRecord(doc) : null;
	} else {
		const row = await db
			.prepare("SELECT id, filename, mime_type, size, storage_key, created_at, status FROM media WHERE id = ?")
			.bind(id)
			.first<{ id: string; filename: string; mime_type: string; size: number | null; storage_key: string; created_at: string; status: string | null }>();
		value =
			row && (row.status ?? "ready") === "ready"
				? {
						id: row.id,
						source: "media",
						name: row.filename,
						type: row.mime_type,
						size: row.size ?? 0,
						uploadedAt: row.created_at,
						key: row.storage_key,
					}
				: null;
	}
	if (fileCache.size >= FILE_CACHE_MAX) fileCache.delete(fileCache.keys().next().value as string);
	fileCache.set(id, { value, at: Date.now() });
	return value;
}

// ── Download counts ──────────────────────────────────────────────

const counter = createDownloadCounter(PLUGIN_ID, COLLECTIONS.counts);

/** Count a download; counts within a second in this isolate are written together after the response. */
export function countDownload(db: D1Database, id: string, waitUntil: (p: Promise<unknown>) => void): void {
	counter.count(db, id, waitUntil);
}
