/**
 * Stored image sizes: resized WebP and AVIF copies of media-library images,
 * made once by the Worker (Images binding) and kept in the media bucket next
 * to the originals, at
 *
 *   v<VARIANTS_VERSION>/<id>-<width>.webp|.avif           (keeps the ratio)
 *   v<VARIANTS_VERSION>/<id>-<width>x<height>.webp|.avif  (cropped to fill, around the focal point)
 *
 * The widths are fixed here and made for every image (on upload, or by the
 * opt-in backfill). The crops are the site's (`images.crops` in
 * astro.config.mjs: the exact sizes its theme shows, such as list thumbnails
 * and avatars) and are made on first use: when a page asks for a crop an
 * image doesn't have yet (croppedImage in pack.ts), so only crops pages
 * actually show cost a transformation.
 *
 * The media host serves them as plain files: no transformation per visit, no
 * Accept-based variation, and a year-long immutable cache. Each image gets a
 * record (src/images/variants-store.ts) once all of its copies are in the
 * bucket; until then pages use the media host's /s/ resizing.
 *
 * The widths and quality are fixed here. Changing them means bumping
 * VARIANTS_VERSION: renders then treat older records as missing, the backfill
 * makes the new set, and its cleanup removes the previous version's files.
 *
 * Pure helpers plus generateVariants() (no imports), so tests can load them.
 */

export const VARIANTS_VERSION = 1;
/** Widths made for each image (only those smaller than the original; the original is the largest candidate). */
export const VARIANT_WIDTHS = [400, 640, 800, 1200, 1600] as const;
export const WEBP_QUALITY = 85;
export const AVIF_QUALITY = 80;
/** Cloudflare doesn't encode AVIF beyond this many pixels on either side; those sizes are stored as WebP under the .avif key too. */
export const AVIF_MAX_DIMENSION = 1200;
/** The Images binding's input limit. */
export const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
/** Originals the Images binding reads on every plan (not AVIF, which needs Enterprise; GIF and SVG stay on /s/). */
export const VARIANT_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const VARIANT_CACHE_CONTROL = "public, max-age=31536000, immutable";

export type Crop = readonly [number, number];

/** Pack-wide crops (none by default); set from the site's `images.crops`. */
let crops: string[] = [];

/** Valid "<w>x<h>" names of the given crops, sorted and deduplicated. */
export function normalizeCrops(list: ReadonlyArray<Crop> | null | undefined): string[] {
	const names = new Set<string>();
	for (const c of list ?? []) {
		const [w, h] = [Math.round(Number(c?.[0])), Math.round(Number(c?.[1]))];
		if (w >= 1 && h >= 1 && w <= 2560 && h <= 2560) names.add(`${w}x${h}`);
	}
	return [...names].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}

/** Set the site's crops (from the plugin options). */
export function setImageCrops(list: ReadonlyArray<Crop> | null | undefined): void {
	crops = normalizeCrops(list);
}

/** The site's crops as "<w>x<h>" names. */
export function imageCrops(): string[] {
	return crops;
}

const cropSize = (name: string): [number, number] => name.split("x").map(Number) as [number, number];

/** What's stored for an image: the widths and crops in the bucket (WebP and AVIF each), or why there are none. */
export interface VariantDoc {
	/** VARIANTS_VERSION the copies were made with. */
	v: number;
	/** Widths stored as both .webp and .avif. Empty when the original is already small. */
	w: number[];
	/** Crops ("<w>x<h>") stored as both .webp and .avif (added as pages first use them). */
	c?: string[];
	/** Set when the image can't have stored sizes (pages keep using /s/ for it, without retrying). */
	skip?: string;
	/** When the record was written (ISO). */
	at: string;
}

export const versionPrefix = (version = VARIANTS_VERSION) => `v${version}/`;
export const variantPrefix = (id: string, version = VARIANTS_VERSION) => `${versionPrefix(version)}${id}-`;
/** Key of a stored copy: `size` is a width, or a crop's "<w>x<h>". */
export const variantKey = (id: string, size: number | string, ext: "webp" | "avif", version = VARIANTS_VERSION) => `${variantPrefix(id, version)}${size}.${ext}`;

/** Why an image can't have stored sizes, or null when it can. */
export function ineligibleReason(mime: string | null | undefined, width: number | null | undefined, size: number | null | undefined): string | null {
	if (!(VARIANT_MIME_TYPES as readonly string[]).includes(String(mime ?? "").toLowerCase())) return "type";
	if (!width || width < 1) return "no-width";
	if (size && size > MAX_SOURCE_BYTES) return "too-large";
	return null;
}

export function eligible(mime: string | null | undefined, width: number | null | undefined, size: number | null | undefined): boolean {
	return ineligibleReason(mime, width, size) === null;
}

/** The widths to store for an original `width` pixels wide. */
export function plannedWidths(width: number, widths: readonly number[] = VARIANT_WIDTHS): number[] {
	return widths.filter((w) => w < width);
}

/** Whether Cloudflare encodes AVIF at this output size (otherwise the WebP is stored under the .avif key too). */
export function avifEncoded(outW: number, outH: number): boolean {
	return outW <= AVIF_MAX_DIMENSION && outH <= AVIF_MAX_DIMENSION;
}

/** Output height of a width copy (0 when the original's height is unknown). */
export function scaledHeight(w: number, width: number, height: number | null | undefined): number {
	return height ? Math.round((height * w) / width) : 0;
}

/** The crops of `list` that fit inside a `width` x `height` original (never upscaled). */
export function plannedCrops(width: number, height: number | null | undefined, list: string[] = crops): string[] {
	if (!height) return [];
	return list.filter((name) => {
		const [w, h] = cropSize(name);
		return w <= width && h <= height;
	});
}

/** A record made with the current widths (and with copies, not a skip). */
export function currentDoc(doc: VariantDoc | null | undefined): doc is VariantDoc {
	return Boolean(doc && doc.v === VARIANTS_VERSION && !doc.skip && Array.isArray(doc.w));
}

/**
 * A crop of an image: stored ("stored"); can't be made, because the image is
 * skipped, the crop is larger than the original or isn't one of the site's
 * crops ("never": use /s/ for good); the image's widths are made but this
 * crop isn't yet ("missing": make it now); or the image has no current
 * record at all ("none").
 */
export function cropState(
	doc: VariantDoc | null | undefined,
	name: string,
	width: number | null | undefined,
	height: number | null | undefined,
	list: string[] = crops,
): "stored" | "never" | "missing" | "none" {
	if (!doc || doc.v !== VARIANTS_VERSION) return "none";
	if (doc.skip) return "never";
	if (doc.c?.includes(name)) return "stored";
	if (!list.includes(name) || !width || !plannedCrops(width, height, [name]).length) return "never";
	return "missing";
}

/** Parse a stored record; null when it isn't one. */
export function parseDoc(raw: unknown): VariantDoc | null {
	let value = raw;
	if (typeof raw === "string") {
		try {
			value = JSON.parse(raw);
		} catch {
			return null;
		}
	}
	const doc = value as Partial<VariantDoc> | null;
	if (!doc || typeof doc !== "object" || typeof doc.v !== "number" || !Array.isArray(doc.w)) return null;
	return {
		v: doc.v,
		w: doc.w.filter((n): n is number => typeof n === "number"),
		...(Array.isArray(doc.c) ? { c: doc.c.filter((n): n is string => typeof n === "string") } : {}),
		at: String(doc.at ?? ""),
		...(doc.skip ? { skip: String(doc.skip) } : {}),
	};
}

export interface ResponsiveSources {
	/** srcset of the AVIF copies (and the original as the largest candidate). */
	avif: string;
	/** srcset of the WebP copies and the original. */
	webp: string;
	/** A middle-sized copy for <img src> (the original when there are none). */
	src: string;
	/** The original. */
	full: string;
}

/**
 * srcsets for an image with a current record. `originalUrl` is the original on
 * the media host and is listed last at its own width, so large screens still
 * get the full image. Browsers pick from the <source> matching a type they
 * accept; its candidates may include the original (not AVIF), which they
 * decode by its real type.
 */
export function variantSrcsets(cdn: string, id: string, doc: VariantDoc, originalUrl: string, originalWidth: number): ResponsiveSources {
	const widths = doc.w.filter((w) => w < originalWidth).sort((a, b) => a - b);
	const set = (ext: "webp" | "avif") => [...widths.map((w) => `${cdn}/${variantKey(id, w, ext, doc.v)} ${w}w`), `${originalUrl} ${originalWidth}w`].join(", ");
	const middle = widths.includes(800) ? 800 : widths[widths.length - 1];
	return { avif: set("avif"), webp: set("webp"), src: middle ? `${cdn}/${variantKey(id, middle, "webp", doc.v)}` : originalUrl, full: originalUrl };
}

/** srcsets of stored crops: `[name, descriptor]` pairs such as ["600x315", "600w"] or ["50x50", "1x"]. */
export function cropSrcsets(cdn: string, id: string, doc: VariantDoc, entries: Array<[string, string]>, srcIndex = 0): { avif: string; webp: string; src: string } {
	const set = (ext: "webp" | "avif") => entries.map(([name, d]) => `${cdn}/${variantKey(id, name, ext, doc.v)} ${d}`).join(", ");
	const pick = entries[Math.min(Math.max(0, srcIndex), entries.length - 1)]?.[0] ?? "";
	return { avif: set("avif"), webp: set("webp"), src: `${cdn}/${variantKey(id, pick, "webp", doc.v)}` };
}

// ── Making the copies ────────────────────────────────────────────

export interface VariantBucket {
	get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; size?: number } | null>;
	put(key: string, value: ArrayBuffer, options?: { httpMetadata?: { contentType?: string; cacheControl?: string } }): Promise<unknown>;
	list(options: { prefix: string; cursor?: string; limit?: number }): Promise<{ objects: Array<{ key: string }>; truncated: boolean; cursor?: string }>;
	delete(keys: string | string[]): Promise<unknown>;
}

export interface ImagesBinding {
	input(stream: ReadableStream): {
		transform(options: Record<string, unknown>): { output(options: { format: string; quality?: number }): Promise<{ response(): Response }> };
	};
	info?(stream: ReadableStream): Promise<{ width?: number; height?: number }>;
}

const streamOf = (bytes: ArrayBuffer) => new Response(bytes).body as ReadableStream;

async function encode(images: ImagesBinding, bytes: ArrayBuffer, transform: Record<string, unknown>, format: "image/webp" | "image/avif", quality: number): Promise<{ body: ArrayBuffer; type: string }> {
	const result = await images.input(streamOf(bytes)).transform(transform).output({ format, quality });
	const response = result.response();
	if (!response.ok) throw new Error(`Images binding answered ${response.status}`);
	const type = response.headers.get("content-type") || format;
	if (!type.startsWith("image/")) throw new Error(`Images binding returned ${type}`);
	return { body: await response.arrayBuffer(), type };
}

/**
 * Make and store the copies of one image: each planned width and crop as
 * WebP and AVIF (AVIF only where Cloudflare encodes it; otherwise the WebP is
 * stored under the .avif key too, so every size has both). Copies already in
 * the bucket are kept. Returns the record to write once everything is stored;
 * throws when a copy can't be made (nothing is recorded then, so it's retried).
 */
export async function generateVariants(options: {
	bucket: VariantBucket;
	images: ImagesBinding;
	/** The original's bucket key. */
	key: string;
	/** Id used in the copies' keys (the media id, or a poster's key without its extension). */
	id: string;
	width: number;
	height?: number | null;
	/** Focal point (0–1 each) the crops keep in view; the center when unset. */
	focal?: { x: number; y: number } | null;
	widths?: readonly number[];
	/** Crop names ("<w>x<h>") to make; none by default (crops are made on first use). */
	crops?: string[];
	now?: () => Date;
}): Promise<VariantDoc> {
	const { bucket, images, key, id, width } = options;
	const widths = plannedWidths(width, options.widths);
	const cropNames = plannedCrops(width, options.height, options.crops ?? []);
	const doc: VariantDoc = { v: VARIANTS_VERSION, w: widths, c: cropNames, at: (options.now?.() ?? new Date()).toISOString() };
	type Job = { size: number | string; transform: Record<string, unknown>; outW: number; outH: number };
	const jobs: Job[] = [
		...widths.map((w) => ({ size: w, transform: { width: w }, outW: w, outH: scaledHeight(w, width, options.height) })),
		...cropNames.map((name) => {
			const [w, h] = cropSize(name);
			const gravity = options.focal && Number.isFinite(options.focal.x) && Number.isFinite(options.focal.y) ? { gravity: { x: options.focal.x, y: options.focal.y } } : {};
			return { size: name, transform: { width: w, height: h, fit: "cover", ...gravity }, outW: w, outH: h };
		}),
	];
	if (!jobs.length) return doc;
	const existing = new Set<string>();
	let cursor: string | undefined;
	do {
		const page = await bucket.list({ prefix: variantPrefix(id), cursor });
		for (const o of page.objects) existing.add(o.key);
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	const missing = jobs.filter((j) => !existing.has(variantKey(id, j.size, "webp")) || !existing.has(variantKey(id, j.size, "avif")));
	if (!missing.length) return doc;
	const object = await bucket.get(key);
	if (!object) throw new Error(`${key} isn't in the media bucket`);
	const bytes = await object.arrayBuffer();
	if (bytes.byteLength > MAX_SOURCE_BYTES) throw new Error(`${key} is over 20 MB`);
	const put = (k: string, file: { body: ArrayBuffer; type: string }) => bucket.put(k, file.body, { httpMetadata: { contentType: file.type, cacheControl: VARIANT_CACHE_CONTROL } });
	// One size at a time (memory), both formats together.
	for (const job of missing) {
		const avifOk = avifEncoded(job.outW, job.outH);
		const [webp, avif] = await Promise.all([
			encode(images, bytes, job.transform, "image/webp", WEBP_QUALITY),
			avifOk ? encode(images, bytes, job.transform, "image/avif", AVIF_QUALITY).catch(() => null) : Promise.resolve(null),
		]);
		await Promise.all([put(variantKey(id, job.size, "webp"), webp), put(variantKey(id, job.size, "avif"), avif ?? webp)]);
	}
	return doc;
}

/** Delete every page of keys under `prefix` (1000 per call), stopping after `budgetMs`. True when none are left. */
async function deletePrefix(bucket: VariantBucket, prefix: string, deadline: number): Promise<boolean> {
	for (;;) {
		const page = await bucket.list({ prefix, limit: 1000 });
		if (page.objects.length) await bucket.delete(page.objects.map((o) => o.key));
		if (!page.truncated && page.objects.length < 1000) return true;
		if (Date.now() > deadline) return false;
	}
}

/** Delete an image's copies of the given versions (when it's deleted from the media library). */
export async function deleteVariants(bucket: VariantBucket, versions: number[], id: string): Promise<void> {
	for (const version of versions) if (version >= 1) await deletePrefix(bucket, variantPrefix(id, version), Number.POSITIVE_INFINITY);
}

/** Delete all copies of an older version. True when it's done; false when the time ran out (call again). */
export function deleteVersion(bucket: VariantBucket, version: number, budgetMs: number): Promise<boolean> {
	if (version < 1) return Promise.resolve(true);
	return deletePrefix(bucket, versionPrefix(version), Date.now() + budgetMs);
}
