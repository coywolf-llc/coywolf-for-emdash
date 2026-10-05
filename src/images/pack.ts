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
 */
import { registerFeatures, siteFeatureOn } from "../core/features.js";
import type { PackMiddleware, PackModule } from "../core/module.js";
import { CLOUDFLARE_API_HOST } from "./cloudflare.js";
import { FORMATS, IMAGE_PATH, cdnOriginalUrl, cdnRedirectUrl, cleanImagePath, imageCdn, parseImagePath, setImageCdn } from "./lib.js";
import { imagesModule } from "./module.js";
import { configureMediaHostDatabase, refreshMediaHost } from "./settings.js";

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
}

let config: { bucket: string; images: string } = { bucket: "MEDIA", images: "IMAGES" };

export function imagesPack(options: ImagesOptions = {}): PackModule {
	config = { bucket: options.bucket ?? "MEDIA", images: options.images ?? "IMAGES" };
	if (options.cdn && !/^https:\/\//i.test(options.cdn.trim())) console.warn("coywolf-pack images: images.cdn must be an https origin like https://media.example.com; ignored.");
	setImageCdn(options.cdn);
	configureMediaHostDatabase(options.database);
	return {
		id: "images",
		label: "Clean Image URLs",
		features: FEATURES,
		routes: imagesModule({ database: options.database }).routes,
		adminPages: [{ path: "/images", label: "Clean Image URLs", icon: "image" }],
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

interface ImagesBinding {
	input(stream: ReadableStream): { transform(options: Record<string, unknown>): { output(options: { format: string; quality?: number }): Promise<{ response(): Response }> } };
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

		const cache = (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default;
		const cacheKey = new Request(context.url.toString(), { method: "GET" });
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
