/**
 * Clean Image URLs module: serves /media/<id>-<w>x<h>.<format> resized copies
 * of media-library images (read from the media bucket, resized by the
 * Cloudflare Images binding, cached at the edge for a year), and gives themes
 * cleanImageUrl() to build them. Off by default.
 */
import { registerFeatures, siteFeatureOn } from "../core/features.js";
import type { PackMiddleware, PackModule } from "../core/module.js";
import { FORMATS, IMAGE_PATH, cleanImagePath, parseImagePath } from "./lib.js";

export const F = { main: "images" } as const;
export const FEATURES = [
	{
		id: F.main,
		label: "Clean image URLs",
		description: "Resized images at short addresses like /media/<id>-600x315.webp instead of /_image?href=… Themes use cleanImageUrl() to build them.",
		default: false,
	},
];
registerFeatures(FEATURES);

export interface ImagesOptions {
	/** R2 binding of the media library. Default "MEDIA". */
	bucket?: string;
	/** Images binding. Default "IMAGES" (the Astro Cloudflare adapter's). */
	images?: string;
}

let config: Required<ImagesOptions> = { bucket: "MEDIA", images: "IMAGES" };

export function imagesPack(options: ImagesOptions = {}): PackModule {
	config = { bucket: options.bucket ?? "MEDIA", images: options.images ?? "IMAGES" };
	return { id: "images", label: "Clean Image URLs", features: FEATURES };
}

/**
 * A clean URL for a resized copy of a media-library image, or null when the
 * feature is off or `src` isn't a media-library file (use your usual image
 * code then). `height` crops to fill; without it the ratio is kept.
 */
export async function cleanImageUrl(src: string | null | undefined, options: { width: number; height?: number; format?: string }): Promise<string | null> {
	const path = cleanImagePath(src, options);
	if (!path || !(await siteFeatureOn(F.main))) return null;
	return path;
}

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

		const cache = (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default;
		const cacheKey = new Request(context.url.toString(), { method: "GET" });
		const hit = cache ? await cache.match(cacheKey) : undefined;
		if (hit) return context.request.method === "HEAD" ? new Response(null, { headers: hit.headers }) : hit;

		const bucket = env[config.bucket] as R2Bucket | undefined;
		const images = env[config.images] as ImagesBinding | undefined;
		if (!bucket || !images) return undefined;
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
		return context.request.method === "HEAD" ? new Response(null, { headers }) : response;
	},
};
