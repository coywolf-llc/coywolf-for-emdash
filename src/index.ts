/**
 * Coywolf Pack for EmDash: one native plugin with Coywolf's features for
 * EmDash sites on Cloudflare. Register it in astro.config.mjs:
 *
 * ```js
 * import { coywolfPlugin } from "@coywolf/emdash";
 * emdash({ plugins: [coywolfPlugin({ backups: { name: "mysite" } })] });
 * ```
 *
 * and add `coywolfPack()` from "@coywolf/emdash/middleware" to the site's
 * middleware. Every feature can be turned on or off under Plugins → Coywolf Pack.
 */
import type { PluginCapability, PluginDescriptor } from "emdash";
import { definePlugin } from "emdash";

import { composeHooks, hookCapabilities } from "./core/compose.js";
import { configureContentUrls } from "./core/content-url.js";
import { PLUGIN_ID, isOn, knownFeatures } from "./core/features.js";
import { featuresRoutes } from "./core/features-module.js";
import type { PackModule } from "./core/module.js";
import { secretSettingsSchema } from "./core/secrets.js";
import { MODULES } from "./modules.js";
import type { CoywolfOptions } from "./options.js";

export type { BackupsOptions } from "./backups/module.js";
export type { RedirectsOptions } from "./redirects/module.js";
export type { VideosOptions } from "./videos/module.js";
export type { RobotsOptions } from "./robots/module.js";
export type { CoywolfOptions } from "./options.js";
export type { ContentUrlOptions, TrailingSlash } from "./core/content-url.js";

const VERSION = "0.13.1";
const PACKAGE = "@coywolf/emdash";

const FEATURES_PAGE = { path: "/features", label: "Coywolf Pack", icon: "toggle-right" };

function buildModules(options: CoywolfOptions): PackModule[] {
	// Module-level, like the search rate limit: createPlugin() runs when the Worker isolate
	// starts (virtual:emdash/plugins), so middleware and Astro components see it too.
	configureContentUrls({ urls: options.urls, trailingSlash: options.trailingSlash, termParents: options.termParents, pageParents: options.pageParents });
	return MODULES.map((factory) => factory(options)).filter((m): m is PackModule => m !== null);
}

function surfaces(modules: PackModule[]) {
	return {
		pages: [FEATURES_PAGE, ...modules.flatMap((m) => m.adminPages ?? [])],
		widgets: modules.flatMap((m) => m.widgets ?? []),
		blocks: modules.flatMap((m) => m.portableTextBlocks ?? []),
		settingsSchema: secretSettingsSchema(modules.map((m) => m.settingsSchema)),
		storage: Object.assign({}, ...modules.map((m) => m.storage ?? {})),
		capabilities: [...new Set([...modules.flatMap((m) => m.capabilities ?? []), ...hookCapabilities(modules)])] as PluginCapability[],
		allowedHosts: [...new Set(modules.flatMap((m) => m.allowedHosts ?? []))],
	};
}

export function coywolfPlugin(options: CoywolfOptions = {}): PluginDescriptor<CoywolfOptions> {
	const s = surfaces(buildModules(options));
	return {
		id: PLUGIN_ID,
		version: VERSION,
		format: "native",
		entrypoint: PACKAGE,
		adminEntry: `${PACKAGE}/admin`,
		componentsEntry: `${PACKAGE}/astro`,
		options,
		adminPages: s.pages,
		adminWidgets: s.widgets,
		portableTextBlocks: s.blocks,
		...(s.capabilities.length ? { capabilities: s.capabilities } : {}),
	};
}

/**
 * The admin definition, with `pages` and `widgets` computed on read: EmDash
 * builds the admin manifest (sidebar, dashboard) from them on every admin
 * request, so a module whose main feature is off drops out of the sidebar.
 * The Features page always stays. Before the switches have been read in this
 * isolate, everything is listed.
 */
function liveAdmin<T extends object>(modules: PackModule[], base: T) {
	const on = (module: PackModule) => {
		const features = knownFeatures();
		return !features || isOn(features, module.features[0]?.id ?? module.id);
	};
	return Object.defineProperties(base, {
		pages: {
			enumerable: true,
			get: () => [FEATURES_PAGE, ...modules.filter(on).flatMap((m) => m.adminPages ?? [])],
		},
		widgets: {
			enumerable: true,
			get: () => modules.filter(on).flatMap((m) => m.widgets ?? []),
		},
	}) as T & { pages: PackModule["adminPages"]; widgets: PackModule["widgets"] };
}

export function createPlugin(options: CoywolfOptions = {}) {
	const modules = buildModules(options);
	const s = surfaces(modules);
	const { hooks, tasks } = composeHooks(modules, { tasks: [] });

	return definePlugin({
		id: PLUGIN_ID,
		version: VERSION,
		...(s.capabilities.length ? { capabilities: s.capabilities } : {}),
		...(s.allowedHosts.length ? { allowedHosts: s.allowedHosts } : {}),
		storage: s.storage,
		admin: liveAdmin(modules, {
			entry: `${PACKAGE}/admin`,
			settingsSchema: s.settingsSchema,
			...(s.blocks.length ? { portableTextBlocks: s.blocks } : {}),
		}),
		// biome-ignore lint/suspicious/noExplicitAny: composed handlers match EmDash's hook types at runtime.
		hooks: hooks as any,
		routes: Object.assign({}, featuresRoutes(modules, tasks), ...modules.map((m) => m.routes ?? {})),
	});
}

export default createPlugin;
