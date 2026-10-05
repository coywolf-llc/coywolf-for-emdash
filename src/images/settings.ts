/**
 * The media host saved on the Clean Image URLs page, read outside the plugin
 * context (theme code, middleware, the page:metadata hook) from D1 in the
 * feature switches' query, sharing their per-isolate cache. Applied to the
 * pure helpers in lib.ts, where it overrides the astro.config.mjs option.
 */
import { invalidateFeatures, readSiteSetting, registerSiteSetting, rememberSiteSetting } from "../core/features.js";
import { setSavedImageCdn } from "./lib.js";

/** Plain settings (edited on the Clean Image URLs page). The API token is a secret, declared in src/core/secrets.ts. */
export const IMAGES_SETTINGS = {
	host: "imagesMediaHost",
	accountId: "imagesAccountId",
	bucket: "imagesBucketName",
	token: "imagesApiToken",
} as const;

registerSiteSetting(IMAGES_SETTINGS.host);
let database = "DB";

export function configureMediaHostDatabase(name: string | undefined): void {
	database = name ?? "DB";
}

/** Forget the cached value (call after saving it), optionally applying the new one right away. */
export function invalidateMediaHost(value?: string | null): void {
	if (value === undefined) {
		invalidateFeatures();
		return;
	}
	setSavedImageCdn(value);
	rememberSiteSetting(IMAGES_SETTINGS.host, value);
}

/** Apply the saved media host (from the feature switches' 30-second cache). Keeps the last value if D1 can't be read. */
export async function refreshMediaHost(): Promise<void> {
	const read = await readSiteSetting(IMAGES_SETTINGS.host, database).catch(() => null);
	// Not on Cloudflare, or no database: the option (if any) stays in use.
	if (read) setSavedImageCdn(typeof read.value === "string" ? read.value : null);
}
