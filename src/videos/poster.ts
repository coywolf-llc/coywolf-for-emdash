/**
 * Video posters from the media host.
 *
 * Stream makes thumbnails on request: even cached ones take 120–450 ms to start
 * arriving, a new one over a second, always as JPEG, and from another host the
 * browser has to connect to first. So the first time a poster is rendered it's
 * copied into the media bucket (one full-size JPEG per video and poster time),
 * and pages use resized WebP/AVIF copies from the media host like any other
 * image. Without a media host, or if the copy fails, Stream's thumbnails are
 * used as before.
 */
import { siteFeatureOn } from "../core/features.js";
import { imageCdn } from "../images/lib.js";
import { refreshMediaHost } from "../images/settings.js";
import { workerEnv } from "../shared.js";
import { POSTER_WIDTHS, posterImage, posterUrl } from "./lib.js";

/** Width of the copy kept in the bucket: covers the largest poster on a 2x screen. */
export const SOURCE_WIDTH = 1600;
const FETCH_TIMEOUT_MS = 5000;
const MEDIA_BINDING = "MEDIA";

type PosterRef = { posterImage?: string; posterTime?: number };

interface Bucket {
	head(key: string): Promise<unknown | null>;
	put(key: string, value: ArrayBuffer, options?: { httpMetadata?: { contentType?: string; cacheControl?: string } }): Promise<unknown>;
}

/** Bucket key for a Stream thumbnail URL: flat, so the media host's /s/<w>/<file> rule resizes it. */
export async function posterKey(uid: string, source: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
	const hash = [...new Uint8Array(digest).slice(0, 6)].map((b) => b.toString(16).padStart(2, "0")).join("");
	return `cwposter-${uid}-${hash}.jpg`;
}

/** Per-isolate: keys already in the bucket (or being copied). A failed copy is forgotten, so it's retried. */
const mirrored = new Map<string, Promise<boolean>>();

/** Copy `source` into the bucket at `key` unless it's there already. True when the bucket has it. */
export function mirrorPoster(bucket: Bucket, key: string, source: string, fetcher: typeof fetch = fetch): Promise<boolean> {
	let pending = mirrored.get(key);
	if (!pending) {
		pending = (async () => {
			if (await bucket.head(key)) return true;
			const res = await fetcher(source, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
			const type = res.headers.get("content-type") ?? "";
			if (!res.ok || !type.startsWith("image/")) return false;
			await bucket.put(key, await res.arrayBuffer(), {
				httpMetadata: { contentType: type, cacheControl: "public, max-age=31536000, immutable" },
			});
			return true;
		})().catch(() => false);
		mirrored.set(key, pending);
		pending.then((ok) => ok || mirrored.delete(key));
	}
	return pending;
}

/** Forget what this isolate has copied (tests). */
export function resetMirroredPosters(): void {
	mirrored.clear();
}

/**
 * The poster as a responsive image from the media host when there is one,
 * else Stream's thumbnails (see posterImage). `full` is a single large URL
 * for the player's own poster.
 */
export async function hostedPosterImage(
	host: string | null,
	uid: string,
	ref: PosterRef,
	fallback: PosterRef = {},
	origin?: string | null,
): Promise<{ src: string; srcset?: string; full: string }> {
	const stream = posterImage(host, uid, ref, fallback, origin);
	const source = posterUrl(host, uid, ref, fallback, SOURCE_WIDTH, origin);
	// An explicit poster image is used as it is.
	if (!stream.srcset) return { ...stream, full: stream.src };
	try {
		if (!(await siteFeatureOn("images"))) return { ...stream, full: source };
		await refreshMediaHost();
		const cdn = imageCdn();
		const bucket = (await workerEnv())[MEDIA_BINDING] as Bucket | undefined;
		if (!cdn || !bucket) return { ...stream, full: source };
		const key = await posterKey(uid, source);
		if (!(await mirrorPoster(bucket, key, source))) return { ...stream, full: source };
		const at = (w: number) => `${cdn}/s/${w}/${key}`;
		return { src: at(800), srcset: POSTER_WIDTHS.map((w) => `${at(w)} ${w}w`).join(", "), full: at(1200) };
	} catch {
		return { ...stream, full: source };
	}
}
