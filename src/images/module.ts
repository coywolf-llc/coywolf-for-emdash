/**
 * Clean Image URLs admin routes: the media host setting, a live check of the
 * media host, and the optional one-click Cloudflare setup (plan, then apply).
 *
 * The Cloudflare API token comes from the request (typed on the page, not
 * stored unless saved), the saved secret, or a Worker secret
 * (IMAGES_API_TOKEN, then CLOUDFLARE_API_TOKEN). It's only sent to
 * api.cloudflare.com, never logged or returned.
 */
import type { PluginContext } from "emdash";
import { PluginRouteError, definePluginRoute } from "emdash";
import { z } from "zod";

import { requireFeature } from "../core/features.js";
import { parseInput, secret, workerEnv } from "../shared.js";
import { CloudflareApiError, type CloudflareConfig, applySetup, checkMediaHost, planSetup, purgeHost } from "./cloudflare.js";
import { imageCdn, imageCdnSource, normalizeMediaHost } from "./lib.js";
import { IMAGES_SETTINGS, invalidateMediaHost, refreshMediaHost } from "./settings.js";

const F = "images";

export const QUOTA_NOTE =
	"Cloudflare's Free plan includes 5,000 unique image transformations a month (each new size of each image counts once a month; repeat views are served from the cache). Beyond that, transformations need a paid Cloudflare Images plan; without one, new sizes stop being made until the next month while existing ones keep working.";

const hostInput = z
	.string()
	.max(253)
	.optional()
	.transform((v, zctx) => {
		if (v === undefined) return undefined;
		if (!v.trim()) return "";
		const host = normalizeMediaHost(v);
		if (!host) {
			zctx.addIssue({ code: "custom", message: "The media host must be an https address like https://media.example.com (no path)." });
			return z.NEVER;
		}
		return host;
	});
const accountInput = z
	.string()
	.trim()
	.max(64)
	.regex(/^([0-9a-f]{32})?$/i, "The account ID is 32 letters and numbers (0-9, a-f).")
	.optional();
const bucketInput = z
	.string()
	.trim()
	.max(63)
	.regex(/^([a-z0-9][a-z0-9-]{1,61}[a-z0-9])?$/, "Bucket names use lowercase letters, numbers and hyphens (3-63 characters).")
	.optional();

const settingsInput = z.object({
	host: hostInput,
	accountId: accountInput,
	bucket: bucketInput,
	token: z.string().trim().max(400).optional(),
	clearToken: z.boolean().optional(),
});

const setupInput = z.object({
	host: hostInput,
	accountId: accountInput,
	bucket: bucketInput,
	token: z.string().trim().max(400).optional(),
});

async function env(): Promise<Record<string, unknown>> {
	try {
		return await workerEnv();
	} catch {
		return {};
	}
}

async function adminSettings(ctx: PluginContext) {
	const [host, accountId, bucket, token] = await Promise.all([
		ctx.settings.get<string>(IMAGES_SETTINGS.host),
		ctx.settings.get<string>(IMAGES_SETTINGS.accountId),
		ctx.settings.get<string>(IMAGES_SETTINGS.bucket),
		ctx.settings.get<string>(IMAGES_SETTINGS.token).catch(() => null),
	]);
	const e = await env();
	invalidateMediaHost(host ?? null);
	const source = imageCdnSource();
	return {
		host: host ?? "",
		optionHost: source.option ?? "",
		activeHost: source.host ?? "",
		accountId: accountId ?? "",
		bucket: bucket ?? "",
		tokenSet: Boolean(token?.trim()),
		envToken: Boolean(secret(e, "IMAGES_API_TOKEN") || secret(e, "CLOUDFLARE_API_TOKEN")),
		envAccountId: Boolean(secret(e, "CF_ACCOUNT_ID") || secret(e, "CLOUDFLARE_ACCOUNT_ID")),
		siteHost: siteHostname(ctx),
		quotaNote: QUOTA_NOTE,
	};
}

function siteHostname(ctx: PluginContext): string {
	try {
		return ctx.site?.url ? new URL(ctx.site.url).hostname.replace(/^www\./, "") : "";
	} catch {
		return "";
	}
}

/** Credentials for the setup: the request's, then the saved ones, then Worker variables. */
async function credentials(ctx: PluginContext, input: z.infer<typeof setupInput>): Promise<CloudflareConfig & { bucket: string; host: string }> {
	const e = await env();
	const savedToken = await ctx.settings.get<string>(IMAGES_SETTINGS.token).catch(() => null);
	const token = input.token || savedToken?.trim() || secret(e, "IMAGES_API_TOKEN") || secret(e, "CLOUDFLARE_API_TOKEN");
	const accountId =
		input.accountId || (await ctx.settings.get<string>(IMAGES_SETTINGS.accountId))?.trim() || secret(e, "CF_ACCOUNT_ID") || secret(e, "CLOUDFLARE_ACCOUNT_ID");
	const bucket = input.bucket || (await ctx.settings.get<string>(IMAGES_SETTINGS.bucket))?.trim() || "";
	const host = input.host || imageCdn() || "";
	const missing = [!host && "media host", !accountId && "Cloudflare account ID", !bucket && "R2 bucket name", !token && "Cloudflare API token"].filter(Boolean);
	if (missing.length) throw PluginRouteError.badRequest(`Enter the ${missing.join(", ")} first.`);
	const doFetch = ctx.http ? (ctx.http.fetch.bind(ctx.http) as CloudflareConfig["fetch"]) : undefined;
	return { token: token as string, accountId: accountId as string, bucket, host, fetch: doFetch };
}

/**
 * Clear the media host's images from Cloudflare's zone cache, with the same
 * token and account as the media host setup (the token also needs
 * Zone → Cache Purge → Purge). Says why when it can't, instead of throwing.
 */
export async function purgeMediaHost(ctx: PluginContext): Promise<{ purged: boolean; host: string | null; message?: string }> {
	await refreshMediaHost();
	const host = imageCdn();
	if (!host) return { purged: false, host: null, message: "No media host is set, so there are no images to clear." };
	const hostname = new URL(host).hostname;
	const e = await env();
	const savedToken = await ctx.settings.get<string>(IMAGES_SETTINGS.token).catch(() => null);
	const token = savedToken?.trim() || secret(e, "IMAGES_API_TOKEN") || secret(e, "CLOUDFLARE_API_TOKEN");
	const accountId = (await ctx.settings.get<string>(IMAGES_SETTINGS.accountId))?.trim() || secret(e, "CF_ACCOUNT_ID") || secret(e, "CLOUDFLARE_ACCOUNT_ID");
	if (!token || !accountId) {
		return {
			purged: false,
			host: hostname,
			message: `Images on ${hostname} weren't cleared: add a Cloudflare API token and account ID on the Clean Image URLs page (the token needs Zone → Cache Purge → Purge).`,
		};
	}
	const doFetch = ctx.http ? (ctx.http.fetch.bind(ctx.http) as CloudflareConfig["fetch"]) : undefined;
	try {
		await purgeHost({ token, accountId, fetch: doFetch }, hostname);
		return { purged: true, host: hostname };
	} catch (error) {
		return { purged: false, host: hostname, message: `Images on ${hostname} weren't cleared. ${error instanceof Error ? error.message : String(error)}` };
	}
}

function apiError(error: unknown): never {
	if (error instanceof CloudflareApiError) throw PluginRouteError.badRequest(error.message);
	throw error;
}

/** A recent image in the media library to check with (SVGs aren't resized). */
async function sampleFile(database: string): Promise<string | null> {
	const e = await env();
	const db = e[database] as D1Database | undefined;
	if (!db) return null;
	const row = await db
		.prepare(
			"SELECT storage_key FROM media WHERE mime_type LIKE 'image/%' AND mime_type NOT LIKE '%svg%' AND (status IS NULL OR status = 'ready') ORDER BY created_at DESC LIMIT 1",
		)
		.first<{ storage_key: string }>()
		.catch(() => null);
	return row?.storage_key && /^[A-Za-z0-9_-]+\.[a-z0-9]{2,5}$/i.test(row.storage_key) ? row.storage_key : null;
}

async function runCheck(host: string, database: string) {
	const file = await sampleFile(database);
	if (!file) throw PluginRouteError.badRequest("Upload an image to the media library first: the check fetches one from the media host.");
	const items = await checkMediaHost(host, file);
	return { host, file, ok: items.filter((i) => i.id !== "cached").every((i) => i.ok), items, quotaNote: QUOTA_NOTE };
}

export function imagesModule(options: { database?: string }) {
	const database = options.database ?? "DB";
	return {
		routes: {
			"images/settings": {
				permission: "plugins:manage" as const,
				handler: async (ctx: PluginContext) => {
					await requireFeature(ctx, F);
					return adminSettings(ctx);
				},
			},

			"images/settings/save": definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "json" },
				handler: async (ctx) => {
					await requireFeature(ctx, F);
					const input = parseInput(settingsInput, ctx.input);
					if (input.host !== undefined) await ctx.settings.set(IMAGES_SETTINGS.host, input.host);
					if (input.accountId !== undefined) await ctx.settings.set(IMAGES_SETTINGS.accountId, input.accountId);
					if (input.bucket !== undefined) await ctx.settings.set(IMAGES_SETTINGS.bucket, input.bucket);
					if (input.clearToken) await ctx.settings.delete(IMAGES_SETTINGS.token);
					else if (input.token) await ctx.settings.set(IMAGES_SETTINGS.token, input.token);
					ctx.log.info("Clean image URLs settings saved", { tokenChanged: Boolean(input.clearToken || input.token) });
					return adminSettings(ctx);
				},
			}),

			"images/check": definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "json" },
				handler: async (ctx) => {
					await requireFeature(ctx, F);
					const { host } = parseInput(z.object({ host: hostInput }), ctx.input ?? {});
					await refreshMediaHost();
					const target = host || imageCdn();
					if (!target) throw PluginRouteError.badRequest("Enter a media host to check.");
					return runCheck(target, database);
				},
			}),

			"images/setup/plan": definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "json" },
				handler: async (ctx) => {
					await requireFeature(ctx, F);
					const config = await credentials(ctx, parseInput(setupInput, ctx.input ?? {}));
					try {
						const { zone, plan } = await planSetup(config, { host: config.host, bucket: config.bucket });
						return { zone: zone.name, plan: { host: plan.host, steps: plan.steps, done: plan.done }, quotaNote: QUOTA_NOTE };
					} catch (error) {
						apiError(error);
					}
				},
			}),

			"images/setup/apply": definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "json" },
				handler: async (ctx) => {
					await requireFeature(ctx, F);
					const config = await credentials(ctx, parseInput(setupInput, ctx.input ?? {}));
					let applied: Awaited<ReturnType<typeof applySetup>>;
					try {
						applied = await applySetup(config, { host: config.host, bucket: config.bucket });
					} catch (error) {
						apiError(error);
					}
					ctx.log.info("Media host setup applied", { zone: applied.zone, steps: applied.results.map((r) => `${r.id}:${r.ok ? "ok" : "failed"}`) });
					const host = normalizeMediaHost(config.host) as string;
					const check = applied.results.every((r) => r.ok) ? await runCheck(host, database).catch(() => null) : null;
					return { zone: applied.zone, results: applied.results, check };
				},
			}),
		},
	};
}
