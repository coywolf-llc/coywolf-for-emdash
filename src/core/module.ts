/**
 * The shape every Coywolf Pack module implements. src/index.ts composes the
 * modules into one EmDash plugin: routes are merged, hooks run in module
 * order (skipping modules whose feature is off), and admin pages, widgets,
 * Portable Text blocks and storage collections are concatenated.
 */
import type { MiddlewareHandler } from "astro";
import type { PluginContext, PluginHooks } from "emdash";

/** A switch on the Features page. */
export interface FeatureDef {
	/** Stable key, e.g. "codeBlocks" or "schema.breadcrumbs". Stored in the "features" setting. */
	id: string;
	label: string;
	description: string;
	/** Default when the site hasn't chosen. Keep new features off so installing changes nothing. */
	default?: boolean;
}

export interface AdminPageDef {
	path: string;
	label: string;
	icon?: string;
}

export interface WidgetDef {
	id: string;
	title: string;
	size: "full" | "half" | "third";
}

/** A scheduled job. `schedule` is cron syntax or @hourly/@daily/@weekly. */
export interface TaskDef {
	name: string;
	schedule: string;
	/** Feature that must be on for the task to run (defaults to the module's main feature). */
	feature?: string;
	handler: (ctx: PluginContext) => Promise<void>;
}

// biome-ignore lint/suspicious/noExplicitAny: hook handler signatures vary per hook name.
type AnyHandler = (event: any, ctx: PluginContext) => Promise<unknown> | unknown;

export interface PackModule {
	/** Module id; also the main feature id unless `features` says otherwise. */
	id: string;
	label: string;
	/** Feature switches. The first one is the module's main switch; the rest are sub-features. */
	features: FeatureDef[];
	/** Plugin routes, served at /_emdash/api/plugins/coywolf-pack/<name>. Prefix names with the module id. */
	// biome-ignore lint/suspicious/noExplicitAny: route definitions are opaque here.
	routes?: Record<string, any>;
	/**
	 * Hook handlers. Return values follow EmDash: content:beforeSave may return
	 * modified content (passed to the next module); page:metadata and
	 * page:fragments return contributions (concatenated).
	 * Each handler runs only when `hookFeature` (or the main feature) is on.
	 */
	hooks?: Partial<Record<keyof PluginHooks, AnyHandler>>;
	/** Feature gating a hook, when it isn't the main feature. Keyed by hook name. */
	hookFeature?: Partial<Record<keyof PluginHooks, string>>;
	tasks?: TaskDef[];
	adminPages?: AdminPageDef[];
	widgets?: WidgetDef[];
	/** EmDash settingsSchema fields (prefix keys with the module id). */
	// biome-ignore lint/suspicious/noExplicitAny: SettingField shape is EmDash's.
	settingsSchema?: Record<string, any>;
	/** Portable Text block types this module adds to the editor (render components live in src/astro). */
	// biome-ignore lint/suspicious/noExplicitAny: PortableTextBlockConfig shape is EmDash's.
	portableTextBlocks?: any[];
	/** Plugin storage collections ({ name: { indexes, uniqueIndexes } }). */
	// biome-ignore lint/suspicious/noExplicitAny: storage config shape is EmDash's.
	storage?: Record<string, any>;
	/** Capabilities this module needs (e.g. "network:request", "email:send"). */
	capabilities?: string[];
	/** Hosts for network:request, if any. */
	allowedHosts?: string[];
}

/**
 * Site-level middleware a module contributes (see src/middleware.ts). Runs
 * only when `feature` is on. Return a Response to answer the request, or
 * undefined to pass it on.
 */
export interface PackMiddleware {
	module: string;
	feature: string;
	handle: (context: Parameters<MiddlewareHandler>[0], env: Record<string, unknown>, waitUntil: (p: Promise<unknown>) => void) => Promise<Response | undefined> | Response | undefined;
}
