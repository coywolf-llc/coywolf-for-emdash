/**
 * Clean Image URLs module: resized copies of media-library images at short,
 * cacheable URLs, and cleanImageUrl() / originalImageUrl() for themes. Off by
 * default.
 *
 * Two modes:
 *  - Media host (recommended): an R2 custom domain on the media bucket with
 *    Cloudflare Image Transformations and two URL-rewrite rules
 *    (https://media.example.com/s/<w>x<h>/<file>). Images never touch the
 *    Worker. Set with `images: { cdn }` or on the Clean Image URLs page.
 *  - Worker route: /media/<id>-<w>x<h>.<format>, read from the media bucket,
 *    resized by the Images binding, cached at the edge for a year. With a
 *    media host set, these old URLs 301 to the media host.
 *
 * Stored image sizes (with a media host): WebP and AVIF copies of each image
 * at fixed widths and at the site's crops, made once when the image is
 * uploaded (or by the backfill) and served as plain files. responsiveImage()
 * and croppedImage() give themes their srcsets; until an image's copies exist
 * they return null and themes use cleanImageUrl() (/s/). See variants.ts.
 */
import type { PluginContext } from "emdash";

import { batchedAll } from "../core/d1-batch.js";
import { isCurrent, registerFeatures, settingsEpoch, siteFeatureOn } from "../core/features.js";
import type { PackMiddleware, PackModule } from "../core/module.js";
import { CLOUDFLARE_API_HOST } from "./cloudflare.js";
import { afterResponse, workerEnv } from "../shared.js";
import { FORMATS, IMAGE_PATH, cdnOriginalUrl, cdnRedirectUrl, cleanImagePath, imageCdn, mediaFile, parseImagePath, parseCdnUrl, setImageCdn, snappedImagePath } from "./lib.js";
import { imagesModule } from "./module.js";
import { markPendingMedia } from "./pending.js";
import { configureMediaHostDatabase, refreshMediaHost } from "./settings.js";
import { type ImagesBinding, type VariantBucket, type VariantDoc, type Crop, VARIANTS_VERSION, cropSrcsets, cropState, currentDoc, eligible, parseDoc, setImageCrops, variantSrcsets } from "./variants.js";
import { type BackfillDeps, type Db, VARIANTS_COLLECTION, backfillStep, forgetMedia, mediaRow, processMedia, startVariantsRun } from "./variants-store.js";
import { upgradeListedPosters } from "../videos/poster.js";

export const F = { main: "images" } as const;
export const FEATURES = [
	{
		id: F.main,
		label: "Clean image URLs",
		description:
			"Resized images at short addresses instead of /_image?href=…: on your own media host (media.example.com/s/600x315/<file>, set up on the Clean Image URLs page) or at /media/<id>-600x315.webp. Themes use cleanImageUrl() to build them.",
		default: false,
	},
];
registerFeatures(FEATURES);

export interface ImagesOptions {
	/** R2 binding of the media library. Default "MEDIA". */
	bucket?: string;
	/** Images binding. Default "IMAGES" (the Astro Cloudflare adapter's). */
	images?: string;
	/**
	 * Media host: an https origin serving the media bucket with the /s/ resize
	 * rules, e.g. "https://media.example.com" (see README, "Clean Image URLs").
	 * A host saved on the Clean Image URLs page takes precedence.
	 */
	cdn?: string;
	/** D1 binding of the site database (for the saved media host). Default "DB". */
	database?: string;
	/**
	 * Cropped sizes the theme shows, as [width, height] pairs (e.g. list
	 * thumbnails and avatars at 1x and 2x). Each image gets these stored as
	 * WebP and AVIF too (when it's at least that large); see croppedImage().
	 */
	crops?: Array<Crop>;
}

let config: { bucket: string; images: string; database: string } = { bucket: "MEDIA", images: "IMAGES", database: "DB" };

/** Scheduled job that makes missing stored sizes. */
export const VARIANTS_TASK = "images-variants";
/** Time and image limits for one run of the backfill (scheduled job; admin route; after an import). */
export const CRON_BUDGET = { budgetMs: 10 * 60_000, maxImages: 40 };
export const ROUTE_BUDGET = { budgetMs: 20_000, maxImages: 25 };

/** The bindings stored sizes need, or null when one is missing (or there's no media host). */
export async function variantDeps(): Promise<BackfillDeps | null> {
	await refreshMediaHost();
	if (!imageCdn()) return null;
	const env: Record<string, unknown> = await workerEnv().catch(() => ({}));
	const db = env[config.database] as Db | undefined;
	const bucket = env[config.bucket] as VariantBucket | undefined;
	const images = env[config.images] as ImagesBinding | undefined;
	if (!db || !bucket || !images) return null;
	return { db, bucket, images, upgradePosters: (deadline) => upgradeListedPosters(db as never, bucket, images, deadline) };
}

/** Run the backfill for a while (no-op without the bindings or a media host). */
export async function runVariantsBackfill(budget: { budgetMs: number; maxImages?: number }) {
	const deps = await variantDeps();
	return deps ? backfillStep(deps, budget) : null;
}

/** Make one uploaded image's stored sizes (after the response). */
async function variantsForUpload(id: string): Promise<void> {
	const deps = await variantDeps();
	if (!deps) return;
	const row = await mediaRow(deps.db, id);
	if (row) await processMedia(deps, row);
	forgetInfo(id);
}

const MEDIA_ITEM = /^\/_emdash\/api\/media\/([A-Za-z0-9_-]+)(?:\/(confirm|replace))?$/;
const WP_MEDIA_IMPORT = "/_emdash/api/import/wordpress/media";

/**
 * Keep stored sizes in step with media-library writes the hooks don't cover,
 * after a successful response (null when the request isn't one):
 * - a deleted image: its copies and record go (whether or not the feature is on);
 * - a confirmed direct upload: its sizes are made (the upload hook ran before the file existed);
 * - a replaced file (same key): its sizes are made again;
 * - a WordPress media import (EmDash's importer doesn't notify plugins): the backfill runs for a while.
 */
export function variantsAfterMediaWrite(method: string, pathname: string, featureOn: boolean): Promise<void> | null {
	if (pathname === WP_MEDIA_IMPORT && method === "POST") {
		if (!featureOn) return null;
		return (async () => {
			const deps = await variantDeps();
			if (!deps) return;
			await startVariantsRun(deps.db, { force: true });
			await backfillStep(deps, ROUTE_BUDGET);
		})();
	}
	const m = MEDIA_ITEM.exec(pathname);
	if (!m) return null;
	const [, id, action] = m;
	if (method === "DELETE" && !action) {
		return (async () => {
			const env: Record<string, unknown> = await workerEnv().catch(() => ({}));
			const db = env[config.database] as Db | undefined;
			const bucket = env[config.bucket] as VariantBucket | undefined;
			if (db && bucket) await forgetMedia({ db, bucket }, id);
			forgetInfo(id);
		})();
	}
	if (method === "POST" && action && featureOn) {
		return (async () => {
			const deps = await variantDeps();
			if (!deps) return;
			if (action === "replace") await forgetMedia(deps, id);
			const row = await mediaRow(deps.db, id);
			if (row) await processMedia(deps, row);
			forgetInfo(id);
		})();
	}
	return null;
}

export function imagesPack(options: ImagesOptions = {}): PackModule {
	config = { bucket: options.bucket ?? "MEDIA", images: options.images ?? "IMAGES", database: options.database ?? "DB" };
	setImageCrops(options.crops);
	if (options.cdn && !/^https:\/\//i.test(options.cdn.trim())) console.warn("coywolf-pack images: images.cdn must be an https origin like https://media.example.com; ignored.");
	setImageCdn(options.cdn);
	configureMediaHostDatabase(options.database);
	return {
		id: "images",
		label: "Clean Image URLs",
		features: FEATURES,
		routes: imagesModule({ database: options.database, variants: { run: () => runVariantsBackfill(ROUTE_BUDGET), deps: variantDeps } }).routes,
		adminPages: [{ path: "/images", label: "Clean Image URLs", icon: "image" }],
		storage: { [VARIANTS_COLLECTION]: { indexes: [] } },
		hooks: {
			// Quick: the sizes are made after the upload's response (waitUntil), not during it.
			"media:afterUpload": async (event: { media: { id: string; mimeType?: string } }) => {
				if (!eligible(event.media.mimeType, 1, 0)) return;
				await afterResponse(variantsForUpload(event.media.id).catch((error) => console.error("coywolf-pack images: stored sizes failed", error)));
			},
		},
		tasks: [
			{
				name: VARIANTS_TASK,
				schedule: "@hourly",
				handler: async (_ctx: PluginContext) => {
					await runVariantsBackfill(CRON_BUDGET);
				},
			},
		],
		capabilities: ["network:request"],
		allowedHosts: [CLOUDFLARE_API_HOST],
	};
}

/**
 * A clean URL for a resized copy of a media-library image, or null when the
 * feature is off or `src` isn't a media-library file (use your usual image
 * code then). `height` crops to fill; without it the ratio is kept.
 */
export async function cleanImageUrl(src: string | null | undefined, options: { width: number; height?: number; format?: string }): Promise<string | null> {
	if (!(await siteFeatureOn(F.main))) return null;
	await refreshMediaHost();
	return cleanImagePath(src, options);
}

/**
 * The original file on the media host (e.g. for a full-size link or an
 * <img> src without resizing). Falls back to `src` itself when the feature
 * is off, no media host is set, or `src` isn't a media-library file.
 */
export async function originalImageUrl<T extends string | null | undefined>(src: T): Promise<string | T> {
	if (!src || !(await siteFeatureOn(F.main))) return src;
	await refreshMediaHost();
	return cdnOriginalUrl(src) ?? src;
}

/** Same as originalImageUrl. */
export const mediaUrl = originalImageUrl;

export interface ImageDimensions {
	width: number;
	height: number;
}

/** A media-library image as pages need it: its size, focal point, and stored sizes (if any). */
export interface ImageInfo {
	/** Media id. */
	id: string;
	width: number | null;
	height: number | null;
	mimeType: string | null;
	size: number | null;
	/** Its stored-sizes record, any version (null when there's none). */
	variants: VariantDoc | null;
}

/** Per isolate, by media id: dropped when settings change (settingsEpoch) or after INFO_TTL_MS. */
const infoCache = new Map<string, { info: ImageInfo | null; epoch: number; at: number }>();
const INFO_TTL_MS = 10 * 60_000;

/** Forget one image (its sizes were just made or removed in this isolate). */
export function forgetInfo(id: string): void {
	infoCache.delete(id);
}

/** The media id and bucket key (<id>.<ext>) of a media-library or media-host URL. */
function mediaRef(src: string): { id: string; key: string } | null {
	const file = mediaFile(src) ?? parseCdnUrl(src.trim());
	return file ? { id: file.id, key: `${file.id}.${file.ext}` } : null;
}

/**
 * Facts about media-library images (size, focal point, stored sizes) for the
 * given sources, in one D1 statement for the whole list (batched with the
 * page's other pack reads of this tick); remembered per isolate for a few
 * minutes. Call it once per page with every image the page shows, then
 * responsiveImage()/croppedImage() for each answer from the cache. Works
 * whether or not Clean image URLs is on. Unknown sources are left out.
 */
export async function imageInfo(srcs: Iterable<string | null | undefined>, database = config.database): Promise<Map<string, ImageInfo>> {
	const result = new Map<string, ImageInfo>();
	const wanted = new Map<string, { id: string; srcs: string[] }>();
	for (const src of srcs) {
		if (!src) continue;
		const ref = mediaRef(src);
		if (!ref) continue;
		const hit = infoCache.get(ref.id);
		if (hit && isCurrent(hit, INFO_TTL_MS)) {
			if (hit.info) result.set(src, hit.info);
			continue;
		}
		const entry = wanted.get(ref.key) ?? { id: ref.id, srcs: [] };
		entry.srcs.push(src);
		wanted.set(ref.key, entry);
	}
	if (!wanted.size) return result;
	const env: Record<string, unknown> = await workerEnv().catch(() => ({}));
	const db = env[database] as D1Database | undefined;
	if (!db) return result;
	const keys = [...wanted.keys()];
	const epoch = settingsEpoch();
	// D1 allows at most 100 bound parameters per query.
	for (let i = 0; i < keys.length; i += 90) {
		const batch = keys.slice(i, i + 90);
		type Row = { id: string; storage_key: string; width: number | null; height: number | null; mime_type: string | null; size: number | null; data: string | null };
		const rows = await batchedAll<Row>(
			db,
			db
				.prepare(
					`SELECT m.id, m.storage_key, m.width, m.height, m.mime_type, m.size, s.data FROM media AS m
					LEFT JOIN _plugin_storage AS s ON s.plugin_id = 'coywolf-pack' AND s.collection = '${VARIANTS_COLLECTION}' AND s.id = m.id
					WHERE m.storage_key IN (${batch.map(() => "?").join(",")})`,
				)
				.bind(...batch),
		);
		const found = new Map(rows.map((r) => [r.storage_key, r]));
		if (infoCache.size > 5000) infoCache.clear();
		for (const key of batch) {
			const row = found.get(key);
			const { id, srcs: sources } = wanted.get(key)!;
			const info: ImageInfo | null = row
				? { id: row.id, width: row.width, height: row.height, mimeType: row.mime_type, size: row.size, variants: parseDoc(row.data) }
				: null;
			infoCache.set(id, { info, epoch, at: Date.now() });
			if (info) for (const src of sources) result.set(src, info);
		}
	}
	return result;
}

/**
 * Width and height of media-library images, from the media library itself.
 * For images whose Portable Text block has none (WordPress imports don't record
 * them), so themes can still build responsive srcsets and set width/height.
 * Same single read and cache as imageInfo. Unknown sources are left out.
 */
export async function imageDimensions(srcs: Iterable<string | null | undefined>, database = config.database): Promise<Map<string, ImageDimensions>> {
	const result = new Map<string, ImageDimensions>();
	for (const [src, info] of await imageInfo(srcs, database)) if (info.width && info.height) result.set(src, { width: info.width, height: info.height });
	return result;
}

/** An image's stored sizes as srcsets for a <picture>: AVIF and WebP (the original is the largest candidate). */
export interface ResponsiveImage {
	avif: string;
	webp: string;
	src: string;
	full: string;
	width: number;
	height: number;
}

/** Whether a stored size of this image could exist but doesn't yet (so the page is a stopgap). */
function pending(info: ImageInfo): boolean {
	return eligible(info.mimeType, info.width, info.size) && !(info.variants?.v === VARIANTS_VERSION && info.variants.skip);
}

/**
 * The image's stored widths as AVIF and WebP srcsets (and the original), or
 * null when there are none (the feature is off, there's no media host, the
 * image isn't a media-library file, or its sizes aren't made yet): use
 * cleanImageUrl() then. Pass `locals` (Astro.locals) so a page shown before
 * the sizes exist is cached for minutes, not days.
 */
export async function responsiveImage(src: string | null | undefined, options: { locals?: object | null } = {}): Promise<ResponsiveImage | null> {
	if (!src || !(await siteFeatureOn(F.main))) return null;
	await refreshMediaHost();
	const cdn = imageCdn();
	const original = cdnOriginalUrl(src);
	if (!cdn || !original) return null;
	const info = (await imageInfo([src])).get(src);
	if (!info?.width || !info.height) return null;
	if (!currentDoc(info.variants)) {
		if (pending(info)) markPendingMedia(options.locals);
		return null;
	}
	return { ...variantSrcsets(cdn, info.id, info.variants, original, info.width), width: info.width, height: info.height };
}

/**
 * Stored crops of an image (sizes from the site's `images.crops`) as AVIF and
 * WebP srcsets: `crops` are [width, height, descriptor] such as
 * [600, 315, "600w"] or [50, 50, "1x"]; `src` is the WebP of `srcIndex`. Null
 * when any of them isn't stored (use cleanImageUrl() then); a page shown
 * while they're being made is marked as a stopgap through `locals`.
 */
export async function croppedImage(
	src: string | null | undefined,
	crops: Array<readonly [number, number, string]>,
	options: { locals?: object | null; srcIndex?: number } = {},
): Promise<{ avif: string; webp: string; src: string } | null> {
	if (!src || !crops.length || !(await siteFeatureOn(F.main))) return null;
	await refreshMediaHost();
	const cdn = imageCdn();
	if (!cdn || !cdnOriginalUrl(src)) return null;
	const info = (await imageInfo([src])).get(src);
	if (!info) return null;
	const names = crops.map(([w, h]) => `${Math.round(w)}x${Math.round(h)}`);
	const states = names.map((name) => cropState(info.variants, name));
	if (states.every((s) => s === "stored")) return cropSrcsets(cdn, info.id, info.variants as VariantDoc, names.map((n, i) => [n, crops[i][2]]), options.srcIndex);
	if (states.includes("pending") && pending(info)) markPendingMedia(options.locals);
	return null;
}

const listCache = new Map<string, string | null>();

/** The bucket key of a file id (files are stored as <id>.<ext>). */
async function findKey(bucket: R2Bucket, id: string): Promise<string | null> {
	if (listCache.has(id)) return listCache.get(id) ?? null;
	const page = await bucket.list({ prefix: `${id}.`, limit: 2 });
	const key = page.objects.find((o) => o.key.startsWith(`${id}.`))?.key ?? null;
	if (listCache.size > 5000) listCache.clear();
	listCache.set(id, key);
	return key;
}

const notFound = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "public, max-age=300" } });

export const imagesMiddleware: PackMiddleware = {
	module: "images",
	feature: F.main,
	handle: async (context, env, waitUntil) => {
		const { pathname } = context.url;
		if (!pathname.startsWith(IMAGE_PATH)) return undefined;
		const request = parseImagePath(pathname);
		if (!request) return undefined;
		if (context.request.method !== "GET" && context.request.method !== "HEAD") return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });

		const bucket = env[config.bucket] as R2Bucket | undefined;
		if (!bucket) return undefined;
		// With a media host, old Worker-route URLs move there (same size; the host picks the format).
		await refreshMediaHost();
		if (imageCdn()) {
			const key = await findKey(bucket, request.id);
			const target = key ? cdnRedirectUrl(request, key) : null;
			if (!target) return notFound();
			return new Response(null, { status: 301, headers: { Location: target, "Cache-Control": "public, max-age=86400" } });
		}

		// Only sizes on the grid are resized; anything else moves to the nearest one up.
		const snapped = snappedImagePath(request);
		if (snapped) return new Response(null, { status: 301, headers: { Location: snapped, "Cache-Control": "public, max-age=86400" } });

		const cache = (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default;
		// Keyed by path alone: a query string can't force a fresh (billed) transform.
		const cacheKey = new Request(`${context.url.origin}${pathname}`, { method: "GET" });
		const hit = cache ? await cache.match(cacheKey) : undefined;
		// Cached responses have immutable headers; hand back a copy later middleware can still change.
		if (hit) return new Response(context.request.method === "HEAD" ? null : hit.body, { status: hit.status, headers: new Headers(hit.headers) });

		const images = env[config.images] as ImagesBinding | undefined;
		if (!images) return undefined;
		const key = await findKey(bucket, request.id);
		if (!key) return notFound();
		const object = await bucket.get(key);
		if (!object) return notFound();
		if ((object.httpMetadata?.contentType ?? "").includes("svg")) return notFound();

		let out: Response;
		try {
			const transformed = await images
				.input(object.body)
				.transform(request.height === undefined ? { width: request.width } : { width: request.width, height: request.height, fit: "cover" })
				.output({ format: FORMATS[request.format], quality: 85 });
			out = transformed.response();
		} catch (error) {
			console.error("coywolf-pack images: transform failed", key, error);
			return new Response("Could not resize this image", { status: 502, headers: { "Cache-Control": "no-store" } });
		}
		const headers = new Headers(out.headers);
		headers.set("Content-Type", FORMATS[request.format]);
		headers.set("Cache-Control", "public, max-age=31536000, immutable");
		headers.set("X-Content-Type-Options", "nosniff");
		const response = new Response(out.body, { status: 200, headers });
		if (cache) waitUntil(cache.put(cacheKey, response.clone()));
		return context.request.method === "HEAD" ? new Response(null, { headers: new Headers(headers) }) : response;
	},
};
