/**
 * Schema & Social module: the page:metadata hook (JSON-LD @graph, robots
 * directives, Open Graph extras) and the routes behind the Schema admin page.
 *
 * Simple values are settings (settingsSchema); structured data lives in
 * plugin storage: schemaDocs ("site" = Site Details, "types" = per-collection
 * type defaults), schemaEntries (per-entry type overrides, id
 * "<collection>:<entry id>") and schemaAuthors (Person property rows per
 * byline id).
 */
import type { PageMetadataContribution, PluginContext, PublicPageContext } from "emdash";
import { PluginRouteError, definePluginRoute } from "emdash";
import { z } from "zod";

import { type FeatureMap, ctxFeatures, isOn, requireFeature } from "../core/features.js";
import { parseInput, workerEnv } from "../shared.js";
import { ARTICLE_TYPES, ORGANIZATION_PROPERTIES, PAGE_TYPES, PERSON_PROPERTIES, PROPERTY_INPUTS } from "./catalog.js";
import {
	type BylineFacts,
	CUSTOM_KEY,
	HOME_KEY,
	type ImageInfo,
	type Node,
	type PropertyRow,
	type SiteDetails,
	type TypeChoice,
	type TypeMap,
	absolute,
	authorPath,
	breadcrumbDocument,
	buildGraph,
	enrichImageObjects,
	mediaRefFromUrl,
	ogLocale,
	originOf,
	pageUrl,
	personNode,
	publisherNode,
	resolveTypes,
	robotsContent,
} from "./graph.js";

export interface SchemaOptions {
	/** D1 binding of the site database (for media dimension lookups). Default "DB". */
	database?: string;
}

export const SCHEMA_FEATURES = {
	main: "schema",
	graph: "schema.graph",
	breadcrumbs: "schema.breadcrumbs",
	robots: "schema.robots",
	openGraph: "schema.openGraph",
	authors: "schema.authors",
} as const;

export const schemaSettingsSchema = {
	schemaSearchUrl: {
		type: "string",
		label: "Schema: search URL template",
		description: "Adds a SearchAction to the WebSite node. Use {search_term_string} for the query. Leave empty for none.",
		default: "/?s={search_term_string}",
	},
	schemaAuthorUrlPattern: {
		type: "string",
		label: "Schema: author page URL",
		description: "Used for an author's url and @id when the byline has no website. {slug} is the byline slug. Leave empty for none.",
		default: "/author/{slug}/",
	},
	schemaBreadcrumbHome: {
		type: "string",
		label: "Schema: breadcrumb home label",
		description: "First crumb of breadcrumb trails derived from the URL path.",
		default: "Home",
	},
	schemaRobotsMaxImage: {
		type: "select",
		label: "Robots: max-image-preview",
		options: [
			{ value: "large", label: "Large" },
			{ value: "standard", label: "Standard" },
			{ value: "none", label: "None" },
			{ value: "", label: "Don't set" },
		],
		default: "large",
	},
	schemaRobotsMaxSnippet: {
		type: "number",
		label: "Robots: max-snippet",
		description: "Characters; -1 for no limit.",
		default: -1,
		min: -1,
	},
	schemaRobotsMaxVideo: {
		type: "number",
		label: "Robots: max-video-preview",
		description: "Seconds; -1 for no limit.",
		default: -1,
		min: -1,
	},
	schemaRobotsNofollow: {
		type: "boolean",
		label: "Robots: nofollow every page",
		default: false,
	},
	schemaOgLocale: {
		type: "string",
		label: "Open Graph: og:locale",
		description: "For example en_US. Leave empty to derive it from the site locale.",
		default: "",
	},
} as const;

type SettingKey = keyof typeof schemaSettingsSchema;
type SimpleSettings = { [K in SettingKey]: (typeof schemaSettingsSchema)[K]["default"] extends number ? number : (typeof schemaSettingsSchema)[K]["default"] extends boolean ? boolean : string };

export const schemaStorage = {
	schemaDocs: { indexes: [] as string[] },
	schemaEntries: { indexes: ["collection"] },
	schemaAuthors: { indexes: [] as string[] },
};

interface EntryOverride extends TypeChoice {
	collection: string;
	entryId: string;
	title?: string;
	updatedAt?: string;
}

// biome-ignore lint/suspicious/noExplicitAny: storage collections are untyped at this layer.
type Coll = any;
const docs = (ctx: PluginContext): Coll => (ctx.storage as Record<string, Coll>).schemaDocs;
const entries = (ctx: PluginContext): Coll => (ctx.storage as Record<string, Coll>).schemaEntries;
const authorsStore = (ctx: PluginContext): Coll => (ctx.storage as Record<string, Coll>).schemaAuthors;

// ── Config (cached per isolate) ──────────────────────────────────

interface Config {
	settings: SimpleSettings;
	site: SiteDetails;
	types: TypeMap;
	/** The publisher Person's byline and rows, when Site Details say "person". */
	person: { byline: BylineFacts | null; rows: PropertyRow[] | null } | null;
}

const CONFIG_TTL_MS = 30_000;
let configCache: { at: number; config: Config } | null = null;

export function invalidateSchemaConfig(): void {
	configCache = null;
}

const DEFAULT_SITE: SiteDetails = { publisherType: "organization", personBylineId: null, orgRows: [] };

async function readSettings(ctx: PluginContext): Promise<SimpleSettings> {
	const keys = Object.keys(schemaSettingsSchema) as SettingKey[];
	const values = await Promise.all(keys.map((k) => ctx.settings.get<unknown>(k)));
	const out: Record<string, unknown> = {};
	keys.forEach((k, i) => {
		out[k] = values[i] ?? schemaSettingsSchema[k].default;
	});
	return out as SimpleSettings;
}

async function bylineFacts(ctx: PluginContext, id: string): Promise<BylineFacts | null> {
	const byline = await ctx.bylines?.get(id).catch(() => null);
	if (!byline) return null;
	let avatarUrl: string | null = null;
	if (byline.avatarMediaId) avatarUrl = (await ctx.media?.get(byline.avatarMediaId).catch(() => null))?.url ?? null;
	return { id: byline.id, slug: byline.slug, displayName: byline.displayName, bio: byline.bio, websiteUrl: byline.websiteUrl, avatarUrl };
}

async function loadConfig(ctx: PluginContext): Promise<Config> {
	if (configCache && Date.now() - configCache.at < CONFIG_TTL_MS) return configCache.config;
	const [settings, stored] = await Promise.all([readSettings(ctx), docs(ctx).getMany(["site", "types"]) as Promise<Map<string, unknown>>]);
	const site = { ...DEFAULT_SITE, ...((stored.get("site") as SiteDetails | undefined) ?? {}) };
	const types = (stored.get("types") as TypeMap | undefined) ?? {};
	let person: Config["person"] = null;
	if (site.publisherType === "person" && site.personBylineId) {
		const [byline, rows] = await Promise.all([
			bylineFacts(ctx, site.personBylineId),
			authorsStore(ctx).get(site.personBylineId) as Promise<{ rows: PropertyRow[] } | null>,
		]);
		person = { byline, rows: rows?.rows ?? null };
	}
	const config = { settings, site, types, person };
	configCache = { at: Date.now(), config };
	return config;
}

// ── Media lookups (dimensions and alt, cached per isolate) ───────

const MEDIA_TTL_MS = 10 * 60_000;
const MEDIA_MAX = 500;
const mediaCache = new Map<string, { at: number; info: ImageInfo | null }>();

async function lookupMedia(options: SchemaOptions, url: string, origin: string): Promise<ImageInfo | null> {
	const ref = mediaRefFromUrl(url, origin);
	if (!ref) return null;
	const cacheKey = `${ref.by}:${ref.value}`;
	const hit = mediaCache.get(cacheKey);
	if (hit && Date.now() - hit.at < MEDIA_TTL_MS) return hit.info ? { ...hit.info, url } : null;
	let info: ImageInfo | null = null;
	try {
		const env = await workerEnv();
		const db = env[options.database ?? "DB"] as D1Database | undefined;
		const row = db
			? await db
					.prepare(`SELECT width, height, alt, mime_type FROM media WHERE ${ref.by === "id" ? "id" : "storage_key"} = ? LIMIT 1`)
					.bind(ref.value)
					.first<{ width: number | null; height: number | null; alt: string | null; mime_type: string | null }>()
			: null;
		if (row) info = { url, width: row.width, height: row.height, alt: row.alt, mimeType: row.mime_type };
	} catch {
		return null; // Don't cache failures.
	}
	if (mediaCache.size >= MEDIA_MAX) mediaCache.delete(mediaCache.keys().next().value as string);
	mediaCache.set(cacheKey, { at: Date.now(), info });
	return info;
}

// ── page:metadata ────────────────────────────────────────────────

interface SiteFacts {
	origin: string;
	siteName: string;
	tagline: string | null;
	logo: ImageInfo | null;
	defaultOgImage: ImageInfo | null;
}

async function siteFacts(ctx: PluginContext, page: PublicPageContext): Promise<SiteFacts> {
	// biome-ignore lint/suspicious/noExplicitAny: SiteSettings is request-cached by EmDash; read loosely.
	let settings: any = {};
	try {
		const { getSiteSettings } = await import("emdash");
		settings = await getSiteSettings();
	} catch {
		// Outside a request context (or no database): fall back to the plugin context.
	}
	const base = page.siteUrl || settings.url || ctx.site.url || (URL.canParse(page.url) ? new URL(page.url).origin : "");
	const origin = originOf(base);
	const ref = (m: { url?: string; width?: number; height?: number; alt?: string } | undefined): ImageInfo | null =>
		m?.url ? { url: absolute(m.url, origin) ?? m.url, width: m.width, height: m.height, alt: m.alt } : null;
	return {
		origin,
		siteName: page.siteName || settings.title || ctx.site.name,
		tagline: settings.tagline || null,
		logo: ref(settings.logo),
		defaultOgImage: ref(settings.seo?.defaultOgImage),
	};
}

/** The og:image EmDash will emit for this page (same precedence as core). */
async function primaryImage(options: SchemaOptions, page: PublicPageContext, site: SiteFacts): Promise<ImageInfo | null> {
	const own = page.seo?.ogImage || page.image;
	if (!own) return site.defaultOgImage;
	const url = absolute(own, site.origin) ?? own;
	return (await lookupMedia(options, own, site.origin)) ?? { url };
}

async function authorNodes(ctx: PluginContext, page: PublicPageContext, config: Config, site: SiteFacts, features: FeatureMap): Promise<Node[]> {
	if (!page.content || !ctx.bylines) return [];
	const [credits] = await ctx.bylines.getEntriesBylines(page.content.collection, [page.content.id]).catch(() => []);
	const bylines = credits?.bylines.map((c) => c.byline) ?? [];
	if (!bylines.length) return [];
	const rowsById: Map<string, { rows: PropertyRow[] }> = isOn(features, SCHEMA_FEATURES.authors)
		? await authorsStore(ctx).getMany(bylines.map((b) => b.id))
		: new Map();
	const nodes = await Promise.all(
		bylines.map(async (b) => {
			const rows = rowsById.get(b.id)?.rows ?? null;
			const hasImage = rows?.some((r) => r.prop === "image" && r.value);
			const avatarUrl = !hasImage && b.avatarMediaId ? ((await ctx.media?.get(b.avatarMediaId).catch(() => null))?.url ?? null) : null;
			const path = authorPath(config.settings.schemaAuthorUrlPattern, b.slug);
			const authorUrl = path ? absolute(path, site.origin) : null;
			return personNode({
				byline: { id: b.id, slug: b.slug, displayName: b.displayName, bio: b.bio, websiteUrl: b.websiteUrl, avatarUrl },
				rows,
				origin: site.origin,
				defaultId: authorUrl ? `${authorUrl}#person` : `${site.origin}/#person-${encodeURIComponent(b.slug)}`,
				authorUrl,
			});
		}),
	);
	return nodes.filter((n): n is Node => n !== null);
}

/** Every contribution this module makes for a page (also used by the admin preview). */
export async function schemaContributions(
	ctx: PluginContext,
	page: PublicPageContext,
	options: SchemaOptions,
	features?: FeatureMap,
): Promise<PageMetadataContribution[]> {
	const on = features ?? (await ctxFeatures(ctx));
	if (!isOn(on, SCHEMA_FEATURES.main)) return [];
	const config = await loadConfig(ctx);
	const site = await siteFacts(ctx, page);
	const out: PageMetadataContribution[] = [];
	const graphOn = isOn(on, SCHEMA_FEATURES.graph);
	const ogOn = isOn(on, SCHEMA_FEATURES.openGraph);
	const image = graphOn || ogOn ? await primaryImage(options, page, site) : null;

	if (graphOn) {
		const override = page.content
			? ((await entries(ctx).get(`${page.content.collection}:${page.content.id}`)) as EntryOverride | null)
			: null;
		const { articleType } = resolveTypes(page, config.types, override);
		const authors = articleType !== "none" ? await authorNodes(ctx, page, config, site, on) : [];
		const personPath = config.person?.byline ? authorPath(config.settings.schemaAuthorUrlPattern, config.person.byline.slug) : null;
		const publisher = publisherNode({
			details: config.site,
			origin: site.origin,
			siteName: site.siteName,
			siteLogo: site.logo,
			person: config.person,
			authorUrl: personPath ? absolute(personPath, site.origin) : null,
		});
		const logoUrl = (publisher.logo as Node | undefined)?.url;
		const logoInfo = typeof logoUrl === "string" ? await lookupMedia(options, logoUrl, site.origin) : null;
		enrichImageObjects(publisher, (url) => (url === logoUrl ? logoInfo : null));
		const graph = buildGraph({
			page,
			origin: site.origin,
			siteName: site.siteName,
			tagline: site.tagline,
			language: page.locale || ctx.site.locale || null,
			types: config.types,
			override,
			searchUrl: config.settings.schemaSearchUrl,
			publisher,
			authors,
			image,
			breadcrumbs: isOn(on, SCHEMA_FEATURES.breadcrumbs),
			homeLabel: config.settings.schemaBreadcrumbHome || "Home",
		});
		// Same id as EmDash's own JSON-LD, so this graph replaces it (first contribution wins).
		out.push({ kind: "jsonld", id: "primary", graph });
	} else if (isOn(on, SCHEMA_FEATURES.breadcrumbs)) {
		const doc = breadcrumbDocument(page, site.origin, config.settings.schemaBreadcrumbHome || "Home");
		if (doc) out.push({ kind: "jsonld", id: "coywolf-breadcrumbs", graph: doc });
	}

	if (isOn(on, SCHEMA_FEATURES.robots)) {
		const s = config.settings;
		out.push({
			kind: "meta",
			name: "robots",
			content: robotsContent(page.seo?.robots, {
				maxImagePreview: s.schemaRobotsMaxImage,
				maxSnippet: Number.isFinite(Number(s.schemaRobotsMaxSnippet)) ? Number(s.schemaRobotsMaxSnippet) : null,
				maxVideoPreview: Number.isFinite(Number(s.schemaRobotsMaxVideo)) ? Number(s.schemaRobotsMaxVideo) : null,
				nofollow: !!s.schemaRobotsNofollow,
			}),
		});
	}

	if (ogOn) {
		const locale = config.settings.schemaOgLocale?.trim() || ogLocale(page.locale || ctx.site.locale);
		if (locale) out.push({ kind: "property", property: "og:locale", content: locale });
		if (image) {
			if (image.width && image.height) {
				out.push({ kind: "property", property: "og:image:width", content: String(image.width) });
				out.push({ kind: "property", property: "og:image:height", content: String(image.height) });
			}
			if (image.mimeType?.startsWith("image/")) out.push({ kind: "property", property: "og:image:type", content: image.mimeType });
			if (image.alt?.trim()) {
				out.push({ kind: "property", property: "og:image:alt", content: image.alt.trim() });
				out.push({ kind: "meta", name: "twitter:image:alt", content: image.alt.trim() });
			}
		}
	}
	return out;
}

// ── Admin routes ─────────────────────────────────────────────────

const ORG_SET = new Set(ORGANIZATION_PROPERTIES);
const PERSON_SET = new Set(PERSON_PROPERTIES);
const TYPE_SET = new Set(PAGE_TYPES.map(([t]) => t));
const ARTICLE_SET = new Set(ARTICLE_TYPES.map(([t]) => t));

const rowInput = z.object({ prop: z.string().max(100), value: z.union([z.string().max(5000), z.record(z.string(), z.string().max(2000))]) });
const typeChoiceInput = z.object({ pageType: z.string().max(60).optional(), articleType: z.string().max(60).optional() });

function cleanValue(value: string, input: string | undefined): string {
	const v = value.trim();
	if (!v) return "";
	if (input === "url" || input === "image") return /^https?:\/\//i.test(v) || (v.startsWith("/") && !v.startsWith("//")) ? v : "";
	if (input === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : "";
	if (input === "number") return /^\d+$/.test(v) ? v : "";
	return v.replace(/[\u0000-\u001f]/g, " ");
}

/** Keep only catalog properties with valid values, like Coywolf SEO's sanitize_properties(). */
export function sanitizeRows(rows: z.infer<typeof rowInput>[], allowed: Set<string>): PropertyRow[] {
	const out: PropertyRow[] = [];
	for (const row of rows) {
		if (!allowed.has(row.prop)) continue;
		const meta = PROPERTY_INPUTS[row.prop] ?? { input: "text" };
		if (meta.fields) {
			if (typeof row.value !== "object") continue;
			const value: Record<string, string> = {};
			for (const [sub, subMeta] of Object.entries(meta.fields)) {
				const v = cleanValue(row.value[sub] ?? "", subMeta.input);
				if (v) value[sub] = v;
			}
			if (Object.keys(value).length) out.push({ prop: row.prop, value });
		} else {
			if (typeof row.value !== "string") continue;
			const value = cleanValue(row.value, meta.input);
			if (value) out.push({ prop: row.prop, value });
		}
	}
	return out;
}

function cleanChoice(choice: TypeChoice): TypeChoice {
	const out: TypeChoice = {};
	if (choice.pageType && TYPE_SET.has(choice.pageType)) out.pageType = choice.pageType;
	if (choice.articleType && ARTICLE_SET.has(choice.articleType)) out.articleType = choice.articleType;
	return out;
}

function entryTitle(data: Record<string, unknown>, titleField: string | null | undefined): string {
	const value = (titleField && data[titleField]) || data.title || data.name || data.headline;
	return typeof value === "string" ? value : "";
}

const MAIN = SCHEMA_FEATURES.main;

export function schemaModule(options: SchemaOptions) {
	const routes = {
		/** Everything the admin page needs to render. */
		"schema/config": {
			permission: "plugins:manage" as const,
			handler: async (ctx: PluginContext) => {
				await requireFeature(ctx, MAIN);
				invalidateSchemaConfig();
				const [config, collections, features] = await Promise.all([
					loadConfig(ctx),
					ctx.schema?.listCollections().catch(() => []) ?? [],
					ctxFeatures(ctx),
				]);
				return {
					settings: config.settings,
					site: config.site,
					types: config.types,
					collections: collections
						.filter((c) => !c.hidden)
						.map((c) => ({ slug: c.slug, label: c.label, routable: c.routable, dated: !!c.dateField })),
					features: Object.fromEntries(Object.values(SCHEMA_FEATURES).map((id) => [id, isOn(features, id)])),
					catalog: {
						pageTypes: PAGE_TYPES,
						articleTypes: ARTICLE_TYPES,
						organization: ORGANIZATION_PROPERTIES,
						person: PERSON_PROPERTIES,
						inputs: PROPERTY_INPUTS,
					},
					keys: { home: HOME_KEY, custom: CUSTOM_KEY },
				};
			},
		},

		"schema/settings/save": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await requireFeature(ctx, MAIN);
				const input = parseInput(
					z.object({
						schemaSearchUrl: z.string().max(500).optional(),
						schemaAuthorUrlPattern: z.string().max(500).optional(),
						schemaBreadcrumbHome: z.string().max(100).optional(),
						schemaRobotsMaxImage: z.enum(["large", "standard", "none", ""]).optional(),
						schemaRobotsMaxSnippet: z.number().int().min(-1).max(1_000_000).optional(),
						schemaRobotsMaxVideo: z.number().int().min(-1).max(1_000_000).optional(),
						schemaRobotsNofollow: z.boolean().optional(),
						schemaOgLocale: z
							.string()
							.max(20)
							.regex(/^([a-z]{2,3}_[A-Z]{2})?$/, "og:locale looks like en_US")
							.optional(),
					}),
					ctx.input,
				);
				if (input.schemaSearchUrl && !input.schemaSearchUrl.includes("{search_term_string}"))
					throw PluginRouteError.badRequest("The search URL needs {search_term_string} where the query goes.");
				for (const [key, value] of Object.entries(input)) if (value !== undefined) await ctx.settings.set(key, value);
				invalidateSchemaConfig();
				return { settings: (await loadConfig(ctx)).settings };
			},
		}),

		"schema/site/save": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await requireFeature(ctx, MAIN);
				const input = parseInput(
					z.object({
						publisherType: z.enum(["organization", "person"]),
						personBylineId: z.string().max(100).nullish(),
						orgRows: z.array(rowInput).max(200),
					}),
					ctx.input,
				);
				const site: SiteDetails = {
					publisherType: input.publisherType,
					personBylineId: input.personBylineId || null,
					orgRows: sanitizeRows(input.orgRows, ORG_SET),
				};
				await docs(ctx).put("site", site);
				invalidateSchemaConfig();
				return { site };
			},
		}),

		"schema/types/save": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await requireFeature(ctx, MAIN);
				const { types } = parseInput(z.object({ types: z.record(z.string().max(100), typeChoiceInput) }), ctx.input);
				const clean: TypeMap = {};
				for (const [key, choice] of Object.entries(types)) {
					const c = cleanChoice(choice);
					if (c.pageType || c.articleType) clean[key] = c;
				}
				await docs(ctx).put("types", clean);
				invalidateSchemaConfig();
				return { types: clean };
			},
		}),

		/** Bylines with their saved Person rows. */
		"schema/authors": {
			permission: "plugins:manage" as const,
			handler: async (ctx: PluginContext) => {
				await requireFeature(ctx, MAIN);
				if (!ctx.bylines) return { items: [], authorsOn: false };
				const items: Array<{ id: string; slug: string; displayName: string; bio: string | null; websiteUrl: string | null; locale: string; rows: PropertyRow[] | null }> = [];
				let cursor: string | undefined;
				for (let page = 0; page < 10; page++) {
					const result = await ctx.bylines.list({ limit: 100, cursor });
					for (const b of result.items)
						items.push({ id: b.id, slug: b.slug, displayName: b.displayName, bio: b.bio, websiteUrl: b.websiteUrl, locale: b.locale, rows: null });
					if (!result.hasMore || !result.cursor) break;
					cursor = result.cursor;
				}
				const saved: Map<string, { rows: PropertyRow[] }> = items.length ? await authorsStore(ctx).getMany(items.map((i) => i.id)) : new Map();
				for (const item of items) item.rows = saved.get(item.id)?.rows ?? null;
				return { items, authorsOn: isOn(await ctxFeatures(ctx), SCHEMA_FEATURES.authors) };
			},
		},

		"schema/authors/save": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await requireFeature(ctx, SCHEMA_FEATURES.authors);
				const { bylineId, rows } = parseInput(z.object({ bylineId: z.string().min(1).max(100), rows: z.array(rowInput).max(200) }), ctx.input);
				if (ctx.bylines && !(await ctx.bylines.get(bylineId))) throw PluginRouteError.notFound("Unknown byline.");
				const clean = sanitizeRows(rows, PERSON_SET);
				if (clean.length) await authorsStore(ctx).put(bylineId, { rows: clean, updatedAt: new Date().toISOString() });
				else await authorsStore(ctx).delete(bylineId);
				invalidateSchemaConfig();
				return { rows: clean };
			},
		}),

		/** Per-entry overrides. */
		"schema/entries": {
			permission: "plugins:manage" as const,
			handler: async (ctx: PluginContext) => {
				await requireFeature(ctx, MAIN);
				const items: EntryOverride[] = [];
				let cursor: string | undefined;
				for (let page = 0; page < 20; page++) {
					const result = await entries(ctx).query({ limit: 100, cursor });
					for (const row of result.items as Array<{ data: EntryOverride }>) items.push(row.data);
					if (!result.hasMore || !result.cursor) break;
					cursor = result.cursor;
				}
				items.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
				return { items };
			},
		},

		/** Recent entries of a collection, for picking one to override or preview. */
		"schema/entries/find": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await requireFeature(ctx, MAIN);
				const { collection, query } = parseInput(z.object({ collection: z.string().min(1).max(100), query: z.string().max(200).optional() }), ctx.input);
				if (!ctx.content) throw PluginRouteError.badRequest("Content access is unavailable.");
				const info = await ctx.schema?.getCollection(collection);
				if (!info) throw PluginRouteError.notFound("Unknown collection.");
				const result = await ctx.content.list(collection, { limit: 100, orderBy: { updatedAt: "desc" } }).catch(async () => ctx.content!.list(collection, { limit: 100 }));
				const q = query?.trim().toLowerCase();
				const items = result.items
					.map((item) => ({ id: item.id, slug: item.slug, status: item.status, title: entryTitle(item.data, info.titleField) || item.slug || item.id }))
					.filter((i) => !q || i.title.toLowerCase().includes(q) || (i.slug ?? "").toLowerCase().includes(q));
				return { items: items.slice(0, 50) };
			},
		}),

		"schema/entries/save": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await requireFeature(ctx, MAIN);
				const input = parseInput(
					z.object({ collection: z.string().min(1).max(100), entryId: z.string().min(1).max(100), title: z.string().max(500).optional() }).merge(typeChoiceInput),
					ctx.input,
				);
				const choice = cleanChoice(input);
				const id = `${input.collection}:${input.entryId}`;
				if (!choice.pageType && !choice.articleType) {
					await entries(ctx).delete(id);
					return { deleted: true };
				}
				const item: EntryOverride = { collection: input.collection, entryId: input.entryId, title: input.title, ...choice, updatedAt: new Date().toISOString() };
				await entries(ctx).put(id, item);
				return { item };
			},
		}),

		"schema/entries/delete": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await requireFeature(ctx, MAIN);
				const { collection, entryId } = parseInput(z.object({ collection: z.string().max(100), entryId: z.string().max(100) }), ctx.input);
				return { deleted: await entries(ctx).delete(`${collection}:${entryId}`) };
			},
		}),

		/** Images from the media library, for the logo/image pickers. */
		"schema/media": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await requireFeature(ctx, MAIN);
				const { cursor } = parseInput(z.object({ cursor: z.string().max(500).optional() }), ctx.input);
				if (!ctx.media) return { items: [], hasMore: false };
				const result = await ctx.media.list({ limit: 30, cursor, mimeType: "image/" });
				return {
					items: result.items.map((m) => ({ id: m.id, url: m.url, filename: m.filename, alt: m.alt ?? null, width: m.width ?? null, height: m.height ?? null })),
					cursor: result.cursor,
					hasMore: result.hasMore,
				};
			},
		}),

		/** What this module would add to the head of the home page or an entry. */
		"schema/preview": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await requireFeature(ctx, MAIN);
				const input = parseInput(
					z.object({ target: z.enum(["home", "entry"]), collection: z.string().max(100).optional(), entryId: z.string().max(100).optional() }),
					ctx.input,
				);
				invalidateSchemaConfig();
				const siteUrl = originOf(ctx.site.url);
				let page: PublicPageContext;
				if (input.target === "home") {
					page = { url: `${siteUrl}/`, path: "/", locale: null, kind: "custom", pageType: "website", title: ctx.site.name, pageTitle: ctx.site.name, description: null, canonical: `${siteUrl}/`, image: null, siteName: ctx.site.name };
				} else {
					if (!input.collection || !input.entryId || !ctx.content) throw PluginRouteError.badRequest("Choose an entry.");
					const [item, info] = await Promise.all([ctx.content.get(input.collection, input.entryId), ctx.schema?.getCollection(input.collection)]);
					if (!item) throw PluginRouteError.notFound("Entry not found.");
					const publicUrl = (await ctx.content.getPublicUrl?.(input.collection, input.entryId).catch(() => null)) ?? `${siteUrl}/${item.slug ?? item.id}/`;
					const url = absolute(publicUrl, siteUrl) ?? publicUrl;
					const title = item.seo?.title || entryTitle(item.data, info?.titleField) || item.slug || item.id;
					const image = item.seo?.image ? (item.seo.image.startsWith("/") || /^https?:/i.test(item.seo.image) ? item.seo.image : `/_emdash/api/media/file/${item.seo.image}`) : null;
					page = {
						url,
						path: URL.canParse(url) ? new URL(url).pathname : "/",
						locale: item.locale,
						kind: "content",
						pageType: info?.dateField ? "article" : "website",
						title,
						pageTitle: title,
						description: item.seo?.description || (typeof item.data.excerpt === "string" ? item.data.excerpt : null),
						canonical: item.seo?.canonical ? (absolute(item.seo.canonical, siteUrl) ?? url) : url,
						image,
						content: { collection: input.collection, id: item.id, slug: item.slug },
						seo: { robots: item.seo?.noIndex ? "noindex, nofollow" : null },
						articleMeta: { publishedTime: item.publishedAt, modifiedTime: item.updatedAt },
						siteName: ctx.site.name,
					};
				}
				const contributions = await schemaContributions(ctx, page, options);
				return { page: { url: pageUrl(page), pageType: page.pageType }, contributions };
			},
		}),
	};

	return { routes };
}

/** The hook EmDash calls for each rendered page. */
export function schemaMetadataHook(options: SchemaOptions) {
	return async (event: { page: PublicPageContext }, ctx: PluginContext) => schemaContributions(ctx, event.page, options);
}
