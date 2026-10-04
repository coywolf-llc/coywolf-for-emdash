/**
 * Robots.txt Rules: admin routes. The file itself is served by the pack
 * middleware (./middleware.ts); the URL tester runs in the browser against
 * the generated text (./rep.ts), so it always tests what will be served.
 */
import type { PluginContext } from "emdash";
import { PluginRouteError, definePluginRoute } from "emdash";
import { z } from "zod";

import { requireFeature } from "../core/features.js";
import { parseInput, workerEnv } from "../shared.js";
import { mergeDirectory } from "./bots.js";
import { BASELINE_DATE, baselineBots } from "./directory.js";
import { CONFIG_SETTING, invalidateRobotsCache } from "./middleware.js";
import { RADAR_TOKEN_SETTING, SYNC_STATE_KEY, type SyncState, radarTokenSource, readOverlays, syncRadar } from "./radar.js";
import { PRESETS, RULE_KINDS, RobotsValidationError, type RobotsConfig, generate, normalizeConfig, validateRule } from "./rules.js";

export interface RobotsOptions {
	/** D1 binding of the site database. Default "DB". */
	database?: string;
}

const NO_NEWLINE = /^[^\r\n]*$/;

const ruleInput = z.object({
	id: z.string().min(1).max(64),
	name: z.string().max(200),
	description: z.string().max(500).optional(),
	enabled: z.boolean(),
	agents: z.array(z.string().max(100).regex(NO_NEWLINE, "Crawler tokens can't contain line breaks.")).max(1000),
	directive: z.enum(["allow", "disallow"]),
	kind: z.enum(RULE_KINDS),
	path: z.string().max(2000).optional(),
	ext: z.string().max(20).optional(),
	allow: z.string().max(2000).optional(),
	strict: z.boolean().optional(),
});

const configInput = z.object({
	rules: z.array(ruleInput).max(200),
	includeSitemap: z.boolean(),
	sitemaps: z.array(z.string().max(2000).regex(NO_NEWLINE, "Sitemap URLs can't contain line breaks.")).max(50),
	allowMedia: z.boolean(),
	comments: z.boolean(),
	extra: z.string().max(20_000),
});

async function readEmdashRobots(database: string): Promise<string | null> {
	try {
		const env = await workerEnv();
		const db = env[database] as D1Database | undefined;
		const row = db ? await db.prepare("SELECT value FROM options WHERE name = ?").bind("site:seo").first<{ value: string }>() : null;
		const seo = row?.value ? (JSON.parse(row.value) as { robotsTxt?: string }) : null;
		return seo?.robotsTxt?.trim() ? seo.robotsTxt : null;
	} catch {
		return null;
	}
}

const siteUrlOf = (ctx: PluginContext) => (ctx.site.url || "").replace(/\/+$/, "");

export function robotsModule(options: RobotsOptions) {
	const database = options.database ?? "DB";

	const routes = {
		/** Saved rules, the generated file, and sync status. */
		"robots/get": {
			permission: "plugins:manage" as const,
			handler: async (ctx: PluginContext) => {
				await requireFeature(ctx, "robots");
				const stored = await ctx.settings.get<Partial<RobotsConfig>>(CONFIG_SETTING);
				const config = normalizeConfig(stored);
				const siteUrl = siteUrlOf(ctx);
				const tokenSource = await radarTokenSource(ctx);
				return {
					config,
					saved: stored !== null && stored !== undefined,
					siteUrl,
					preview: generate(config, { siteUrl }),
					emdashRobotsTxt: await readEmdashRobots(database),
					presets: PRESETS,
					radar: {
						tokenSource,
						tokenConfigured: Boolean(tokenSource),
						state: await ctx.kv.get<SyncState>(SYNC_STATE_KEY),
						baselineDate: BASELINE_DATE,
					},
				};
			},
		},

		/** The crawler directory (bundled baseline + Radar overlay). */
		"robots/bots": {
			permission: "plugins:manage" as const,
			handler: async (ctx: PluginContext) => {
				await requireFeature(ctx, "robots");
				return { bots: mergeDirectory(baselineBots(), await readOverlays(ctx)) };
			},
		},

		"robots/save": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json", maxBytes: 512 * 1024 },
			handler: async (ctx) => {
				await requireFeature(ctx, "robots");
				const config = parseInput(configInput, ctx.input) as RobotsConfig;
				try {
					for (const rule of config.rules) validateRule(rule);
				} catch (error) {
					if (error instanceof RobotsValidationError) throw PluginRouteError.badRequest(error.message);
					throw error;
				}
				const siteUrl = siteUrlOf(ctx);
				const preview = generate(config, { siteUrl });
				if (new TextEncoder().encode(preview).length > 500 * 1024) {
					throw PluginRouteError.badRequest("That robots.txt would be over 500 KiB, the most Google reads. Remove some rules.");
				}
				await ctx.settings.set(CONFIG_SETTING, config);
				invalidateRobotsCache();
				ctx.log.info("Robots.txt rules saved", { rules: config.rules.length });
				return { config, preview, saved: true };
			},
		}),

		/** Save (or remove) the Radar API token. It's a secret setting, so EmDash stores it encrypted. */
		"robots/radar-token": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await requireFeature(ctx, "robots");
				const input = parseInput(z.object({ token: z.string().trim().max(500).optional(), clear: z.boolean().optional() }), ctx.input);
				if (input.clear) await ctx.settings.delete(RADAR_TOKEN_SETTING);
				else if (input.token) await ctx.settings.set(RADAR_TOKEN_SETTING, input.token);
				else throw PluginRouteError.badRequest("Enter a Cloudflare Radar API token.");
				ctx.log.info(input.clear ? "Radar token removed" : "Radar token saved");
				const tokenSource = await radarTokenSource(ctx);
				return { tokenSource, tokenConfigured: Boolean(tokenSource) };
			},
		}),

		/** Refresh the crawler directory from Cloudflare Radar now. */
		"robots/refresh": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await requireFeature(ctx, "robots.radarSync");
				try {
					return await syncRadar(ctx);
				} catch (error) {
					throw PluginRouteError.badRequest(error instanceof Error ? error.message : "Radar sync failed");
				}
			},
		}),
	};

	return { routes };
}
