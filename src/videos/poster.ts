/**
 * Video posters from the media host.
 *
 * Stream makes thumbnails on request: even cached ones take 120–450 ms to start
 * arriving, a new one over a second, always as JPEG, and from another host the
 * browser has to connect to first. So each poster is copied into the media
 * bucket (one full-size JPEG per video and poster time), and pages use resized
 * WebP/AVIF copies from the media host like any other image. Without a media
 * host, or until the copy exists, Stream's thumbnails are used.
 *
 * Rendering never waits on the bucket or on Stream: the copied posters are
 * listed in one plugin setting (read with the feature switches, so it costs no
 * query), and a poster that isn't listed yet is rendered from Stream while it's
 * copied (and listed) in the background. Such a page is marked (see
 * markPendingPoster) so the pack middleware caches it for minutes, not days:
 * the next render, once the copy is listed, uses the media host.
 */
import { PLUGIN_ID, registerSiteSetting, rememberSiteSetting, siteFeatureOn, siteSetting } from "../core/features.js";
import { imageCdn } from "../images/lib.js";
import { refreshMediaHost } from "../images/settings.js";
import { workerEnv } from "../shared.js";
import { POSTER_WIDTHS, posterImage, posterUrl } from "./lib.js";

/** Width of the copy kept in the bucket: covers the largest poster on a 2x screen. */
export const SOURCE_WIDTH = 1600;
const FETCH_TIMEOUT_MS = 5000;
const MEDIA_BINDING = "MEDIA";

/** Plugin setting listing the poster keys already in the bucket. */
export const POSTERS_SETTING = "videosMirroredPosters";
export const POSTERS_OPTION = `plugin:${PLUGIN_ID}:settings:${POSTERS_SETTING}`;
/** Most keys the list keeps (about 60 bytes each); past it, new posters are still copied but found per isolate. */
export const MAX_LISTED_POSTERS = 3000;
registerSiteSetting(POSTERS_SETTING);

type PosterRef = { posterImage?: string; posterTime?: number };

interface Bucket {
	head(key: string): Promise<unknown | null>;
	put(key: string, value: ArrayBuffer, options?: { httpMetadata?: { contentType?: string; cacheControl?: string } }): Promise<unknown>;
}

/** The slice of a D1 binding used to list a copied poster. */
interface Db {
	prepare(sql: string): { bind(...values: unknown[]): { run(): Promise<unknown> } };
}

/** Bucket key for a Stream thumbnail URL: flat, so the media host's /s/<w>/<file> rule resizes it. */
export async function posterKey(uid: string, source: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
	const hash = [...new Uint8Array(digest).slice(0, 6)].map((b) => b.toString(16).padStart(2, "0")).join("");
	return `cwposter-${uid}-${hash}.jpg`;
}

/** "copied": newly put in the bucket; "present": it was already there; false: the copy failed. */
export type MirrorResult = "copied" | "present" | false;

/** Per-isolate: copies under way or done. A failed copy is forgotten, so it's retried. */
const mirrored = new Map<string, Promise<MirrorResult>>();
/** Per-isolate: keys known to be in the bucket. */
const present = new Set<string>();

/** Copy `source` into the bucket at `key` unless it's there already. Truthy when the bucket has it. */
export function mirrorPoster(bucket: Bucket, key: string, source: string, fetcher: typeof fetch = fetch): Promise<MirrorResult> {
	let pending = mirrored.get(key);
	if (!pending) {
		pending = (async (): Promise<MirrorResult> => {
			if (await bucket.head(key)) return "present";
			const res = await fetcher(source, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
			const type = res.headers.get("content-type") ?? "";
			if (!res.ok || !type.startsWith("image/")) return false;
			await bucket.put(key, await res.arrayBuffer(), {
				httpMetadata: { contentType: type, cacheControl: "public, max-age=31536000, immutable" },
			});
			return "copied";
		})().catch(() => false as const);
		mirrored.set(key, pending);
		pending.then((ok) => (ok ? present.add(key) : mirrored.delete(key)));
	}
	return pending;
}

/** Request each URL as AVIF and as WebP so the media host resizes and caches them. */
export function warmSizes(urls: string[], fetcher: typeof fetch = fetch): Promise<unknown> {
	return Promise.allSettled(
		urls.flatMap((url) =>
			["image/avif", "image/webp"].map((accept) =>
				fetcher(url, { headers: { accept }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }).then((r) => r.body?.cancel()),
			),
		),
	);
}

/**
 * Add `key` to the listed posters in one statement (no read-modify-write, so
 * renders in other isolates can't drop each other's keys). No-op when it's
 * listed already or the list is full.
 */
export async function listPoster(db: Db, key: string): Promise<void> {
	await db
		.prepare(
			`INSERT INTO options (name, value) VALUES (?1, json_array(?2))
			ON CONFLICT(name) DO UPDATE SET value = json_insert(CASE WHEN json_valid(options.value) AND json_type(options.value) = 'array' THEN options.value ELSE '[]' END, '$[#]', ?2)
			WHERE NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(options.value) THEN options.value ELSE '[]' END) WHERE json_each.value = ?2)
				AND (NOT json_valid(options.value) OR json_type(options.value) <> 'array' OR json_array_length(options.value) < ?3)`,
		)
		.bind(POSTERS_OPTION, key, MAX_LISTED_POSTERS)
		.run();
}

/** The listed keys as a set, rebuilt only when the cached list changes. */
let listedMemo: { list: unknown; keys: Set<string> } | null = null;
function listedKeys(list: unknown): Set<string> {
	if (listedMemo && listedMemo.list === list) return listedMemo.keys;
	const keys = new Set(Array.isArray(list) ? list.filter((k): k is string => typeof k === "string") : []);
	listedMemo = { list, keys };
	return keys;
}

/** Run `promise` after the response (waitUntil), or just let it run outside Workers. */
async function afterResponse(promise: Promise<unknown>): Promise<void> {
	try {
		const workers = (await import("cloudflare:workers")) as unknown as { waitUntil?: (p: Promise<unknown>) => void };
		if (workers.waitUntil) return workers.waitUntil(promise);
	} catch {
		// Not in a Worker.
	}
	void promise;
}

/** Forget what this isolate has copied (tests). */
export function resetMirroredPosters(): void {
	mirrored.clear();
	present.clear();
	listedMemo = null;
	pendingRenders = 0;
}

/** Astro.locals key: this request rendered a Stream poster whose media-host copy is still being made. */
export const PENDING_POSTER_LOCAL = "__cwPendingPoster";
/**
 * Per isolate: Stream posters rendered for callers that didn't pass `locals`
 * (a theme calling hostedPosterImage itself). The middleware compares it before
 * and after a render; a concurrent render in the same isolate can shorten
 * another page's lifetime too, which only costs a re-render.
 */
let pendingRenders = 0;

/** Note that this render shows a Stream poster only until its copy is listed. */
export function markPendingPoster(locals?: object | null): void {
	if (locals && typeof locals === "object") (locals as Record<string, unknown>)[PENDING_POSTER_LOCAL] = true;
	else pendingRenders++;
}

/** How many Stream posters this isolate has rendered without `locals` (see markPendingPoster). */
export function pendingPosterRenders(): number {
	return pendingRenders;
}

/** Whether a request rendered a pending poster: flagged on its locals, or counted since `before`. */
export function renderedPendingPoster(locals: unknown, before: number): boolean {
	return Boolean((locals as Record<string, unknown> | undefined)?.[PENDING_POSTER_LOCAL]) || pendingRenders !== before;
}

export interface PosterDeps {
	cdn: string;
	bucket: Bucket;
	/** Keys listed as copied (from the plugin setting). */
	listed: Set<string>;
	/** List a key once the bucket has it. */
	list: (key: string) => Promise<void>;
	/** Schedule work after the response. */
	defer: (work: Promise<unknown>) => void;
	fetcher?: typeof fetch;
}

/**
 * The media-host poster when the copy is known to exist (listed, or seen by
 * this isolate), else null right away. The copy starts at once (during this
 * render, not after it), and `defer` only keeps it, its listing and (for a new
 * copy only) the resizing of each size alive past the response, so the next
 * render a few minutes later finds it listed.
 */
export async function mediaPoster(uid: string, source: string, deps: PosterDeps): Promise<{ src: string; srcset: string; full: string } | null> {
	const key = await posterKey(uid, source);
	const at = (w: number) => `${deps.cdn}/s/${w}/${key}`;
	if (deps.listed.has(key) || present.has(key)) {
		return { src: at(800), srcset: POSTER_WIDTHS.map((w) => `${at(w)} ${w}w`).join(", "), full: at(1200) };
	}
	if (!mirrored.has(key)) {
		deps.defer(
			mirrorPoster(deps.bucket, key, source, deps.fetcher).then(async (result) => {
				if (!result) return;
				await deps.list(key).catch(() => undefined);
				// Just copied: have the media host make each size now (AVIF and WebP), so the first
				// visitor doesn't wait for the resize. A poster already in the bucket was warmed then.
				if (result === "copied") await warmSizes([...POSTER_WIDTHS.map(at)], deps.fetcher);
			}),
		);
	}
	return null;
}

/**
 * The poster as a responsive image from the media host when there is one,
 * else Stream's thumbnails (see posterImage). `full` is a single large URL
 * for the player's own poster. Pass the page's `Astro.locals` so a page shown
 * with Stream's poster while the copy is made gets a short cache lifetime
 * (without it, the middleware still notices through a per-isolate count).
 */
export async function hostedPosterImage(
	host: string | null,
	uid: string,
	ref: PosterRef,
	fallback: PosterRef = {},
	origin?: string | null,
	/** Astro.locals, so only this page gets the stopgap lifetime. */
	locals?: object | null,
): Promise<{ src: string; srcset?: string; full: string }> {
	const stream = posterImage(host, uid, ref, fallback, origin);
	const source = posterUrl(host, uid, ref, fallback, SOURCE_WIDTH, origin);
	// An explicit poster image is used as it is.
	if (!stream.srcset) return { ...stream, full: stream.src };
	try {
		if (!(await siteFeatureOn("images"))) return { ...stream, full: source };
		await refreshMediaHost();
		const cdn = imageCdn();
		const env = await workerEnv();
		const bucket = env[MEDIA_BINDING] as Bucket | undefined;
		if (!cdn || !bucket) return { ...stream, full: source };
		const list = await siteSetting<unknown>(POSTERS_SETTING);
		const db = env.DB as Db | undefined;
		const media = await mediaPoster(uid, source, {
			cdn,
			bucket,
			listed: listedKeys(list),
			list: async (key) => {
				if (!db) return;
				await listPoster(db, key);
				// This isolate sees it now; others when their settings cache refreshes (FEATURES_TTL_MS).
				const current = (await siteSetting<unknown>(POSTERS_SETTING)) ?? [];
				if (Array.isArray(current) && !current.includes(key)) rememberSiteSetting(POSTERS_SETTING, [...current, key]);
			},
			defer: (work) => void afterResponse(work),
		});
		if (media) return media;
		markPendingPoster(locals);
		return { ...stream, full: source };
	} catch {
		return { ...stream, full: source };
	}
}
