/**
 * Site URLs for the Discovery module, served through the pack middleware:
 *
 * - `/<key>.txt`                       IndexNow key file
 * - `/news-sitemap.xml`                Google News sitemap (also `/coywolf-news-sitemap.xml`, Coywolf SEO's name)
 * - `/llms.txt`                        llms.txt
 * - `<entry-url>/index.html.md`        Markdown source of an entry
 * - any entry URL with `Accept: text/markdown`  the same Markdown (content negotiation)
 *
 * The work happens in the module's public plugin routes (so it runs in the
 * plugin context, with EmDash's URL resolution and the plugin's KV cache);
 * this file dispatches to them through EmDash's public route handler and
 * keeps results briefly in isolate memory.
 */
import type { MiddlewareHandler } from "astro";

import { PLUGIN_ID } from "../core/features.js";
import type { PackMiddleware } from "../core/module.js";
import { keyFromPath } from "./indexnow.js";
import { pagePathFromMarkdownPath } from "./markdown.js";
import { FEATURE } from "./module.js";

type Context = Parameters<MiddlewareHandler>[0];

interface PublicRouteResult {
	success: boolean;
	data?: unknown;
}
type PublicRouteHandler = (pluginId: string, method: string, path: string, request: Request) => Promise<PublicRouteResult>;

const ISOLATE_TTL_MS = 60_000;
const MAX_CACHED = 200;
const memory = new Map<string, { value: unknown; expires: number }>();

/** Call one of the module's public routes. Null when it isn't available or answers with an error (e.g. 404). */
async function callRoute<T>(context: Context, route: string, query: Record<string, string> = {}, ttlMs = ISOLATE_TTL_MS): Promise<T | null> {
	const cacheKey = `${route}?${new URLSearchParams(query)}`;
	const hit = memory.get(cacheKey);
	if (hit && hit.expires > Date.now()) return hit.value as T | null;

	const locals = context.locals as { emdash?: { handlePublicPluginApiRoute?: PublicRouteHandler } };
	const dispatch = locals.emdash?.handlePublicPluginApiRoute;
	if (typeof dispatch !== "function") return null;
	const url = new URL(`/_emdash/api/plugins/${PLUGIN_ID}/${route}`, context.url);
	for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
	const result = await dispatch(PLUGIN_ID, "GET", route, new Request(url, { method: "GET" }));
	const value = result.success ? ((result.data ?? null) as T | null) : null;

	if (memory.size >= MAX_CACHED) memory.delete(memory.keys().next().value as string);
	memory.set(cacheKey, { value, expires: Date.now() + ttlMs });
	return value;
}

const isRead = (context: Context) => context.request.method === "GET" || context.request.method === "HEAD";

function respond(context: Context, body: string, headers: Record<string, string>): Response {
	return new Response(context.request.method === "HEAD" ? null : body, { status: 200, headers });
}

// ── IndexNow key file ────────────────────────────────────────────

export const indexNowKeyMiddleware: PackMiddleware = {
	module: "discovery",
	feature: FEATURE.indexnow,
	handle: async (context) => {
		if (!isRead(context)) return undefined;
		const requested = keyFromPath(context.url.pathname);
		if (!requested) return undefined;
		const result = await callRoute<{ key: string | null }>(context, "discovery/public/key");
		if (!result?.key || result.key !== requested) return undefined;
		return respond(context, result.key, {
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "no-cache",
			"X-Robots-Tag": "noindex",
		});
	},
};

// ── News sitemap ─────────────────────────────────────────────────

const NEWS_PATHS = new Set(["/news-sitemap.xml", "/coywolf-news-sitemap.xml"]);

export const newsSitemapMiddleware: PackMiddleware = {
	module: "discovery",
	feature: FEATURE.news,
	handle: async (context) => {
		if (!isRead(context) || !NEWS_PATHS.has(context.url.pathname)) return undefined;
		const result = await callRoute<{ body: string }>(context, "discovery/public/news");
		if (!result?.body) return undefined;
		return respond(context, result.body, {
			"Content-Type": "application/xml; charset=utf-8",
			"Cache-Control": "public, max-age=300",
			"X-Robots-Tag": "noindex",
		});
	},
};

// ── llms.txt and Markdown sources ────────────────────────────────

/** Paths that are never entry pages (assets, APIs, files with an extension other than .html). */
const NOT_A_PAGE = /^\/(_emdash|_astro|_image|_actions|_server-islands)\/|\.(?!html?$)[a-z0-9]{1,8}$/i;

interface MarkdownDoc {
	body: string;
	tokens: number;
	markdownUrl: string;
}

export const llmsMiddleware: PackMiddleware = {
	module: "discovery",
	feature: FEATURE.llms,
	handle: async (context) => {
		if (!isRead(context)) return undefined;
		const { pathname } = context.url;

		if (pathname === "/llms.txt") {
			const result = await callRoute<{ body: string }>(context, "discovery/public/llms");
			if (!result?.body) return undefined;
			return respond(context, result.body, {
				"Content-Type": "text/plain; charset=utf-8",
				"Cache-Control": "public, max-age=3600",
				"X-Content-Type-Options": "nosniff",
			});
		}

		const pagePath = pagePathFromMarkdownPath(pathname);
		if (pagePath) {
			const doc = await callRoute<MarkdownDoc>(context, "discovery/public/markdown", { path: pagePath });
			if (!doc?.body) return undefined;
			return respond(context, doc.body, {
				"Content-Type": "text/markdown; charset=utf-8",
				"Cache-Control": "public, max-age=3600",
				"X-Markdown-Tokens": String(doc.tokens),
				"X-Content-Type-Options": "nosniff",
			});
		}

		// Content negotiation on the entry's own URL.
		const accept = context.request.headers.get("accept")?.toLowerCase() ?? "";
		if (accept.includes("text/markdown") && !NOT_A_PAGE.test(pathname)) {
			const doc = await callRoute<MarkdownDoc>(context, "discovery/public/markdown", { path: pathname });
			if (!doc?.body) return undefined;
			return respond(context, doc.body, {
				"Content-Type": "text/markdown; charset=utf-8",
				// Never let a URL-keyed cache store the Markdown variant under the HTML URL.
				"Cache-Control": "private, no-store",
				"Content-Location": doc.markdownUrl,
				Vary: "Accept",
				"X-Markdown-Tokens": String(doc.tokens),
				"X-Content-Type-Options": "nosniff",
			});
		}
		return undefined;
	},
};

export const discoveryMiddleware: PackMiddleware[] = [indexNowKeyMiddleware, newsSitemapMiddleware, llmsMiddleware];
