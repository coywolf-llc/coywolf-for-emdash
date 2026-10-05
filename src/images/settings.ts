/**
 * The media host saved on the Clean Image URLs page, read outside the plugin
 * context (theme code, middleware, the page:metadata hook) straight from D1,
 * with a short per-isolate cache like the feature switches. Applied to the
 * pure helpers in lib.ts, where it overrides the astro.config.mjs option.
 */
import { PLUGIN_ID } from "../core/features.js";
import { workerEnv } from "../shared.js";
import { setSavedImageCdn } from "./lib.js";

/** Plain settings (edited on the Clean Image URLs page). The API token is a secret, declared in src/core/secrets.ts. */
export const IMAGES_SETTINGS = {
	host: "imagesMediaHost",
	accountId: "imagesAccountId",
	bucket: "imagesBucketName",
	token: "imagesApiToken",
} as const;

const OPTION_NAME = `plugin:${PLUGIN_ID}:settings:${IMAGES_SETTINGS.host}`;
const TTL_MS = 30_000;
let cachedAt = 0;
let database = "DB";

export function configureMediaHostDatabase(name: string | undefined): void {
	database = name ?? "DB";
}

/** Forget the cached value (call after saving it), optionally applying the new one right away. */
export function invalidateMediaHost(value?: string | null): void {
	cachedAt = 0;
	if (value !== undefined) {
		setSavedImageCdn(value);
		cachedAt = Date.now();
	}
}

/** Refresh the saved media host from D1 (at most every 30 seconds per isolate). Keeps the last value if D1 can't be read. */
export async function refreshMediaHost(): Promise<void> {
	if (Date.now() - cachedAt < TTL_MS) return;
	try {
		const env = await workerEnv();
		const db = env[database] as D1Database | undefined;
		const row = db ? await db.prepare("SELECT value FROM options WHERE name = ?").bind(OPTION_NAME).first<{ value: string }>() : null;
		const stored = row?.value ? JSON.parse(row.value) : null;
		setSavedImageCdn(typeof stored === "string" ? stored : null);
		cachedAt = Date.now();
	} catch {
		// Not on Cloudflare, or no database: the option (if any) stays in use.
		cachedAt = Date.now();
	}
}
