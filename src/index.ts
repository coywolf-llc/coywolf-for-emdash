/**
 * Coywolf for EmDash: one native plugin with Coywolf's features for EmDash
 * sites on Cloudflare. Enable modules in astro.config.mjs:
 *
 * ```js
 * import { coywolfPlugin } from "@coywolf/emdash";
 * emdash({
 *   plugins: [coywolfPlugin({ backups: { name: "mysite" }, redirects: {} })],
 * });
 * ```
 *
 * Modules:
 * - backups: D1 + media backups, rewind/undo, restore to a new database.
 * - redirects: external and file-path redirects with an admin editor
 *   (also add `coywolfRedirects()` from "@coywolf/emdash/middleware").
 */
import type { PluginDescriptor } from "emdash";
import { definePlugin } from "emdash";

import { BACKUPS_TASK, type BackupsOptions, backupsModule, backupsSettingsSchema, ensureBackupsTask } from "./backups/module.js";
import { type RedirectsOptions, redirectsModule } from "./redirects/module.js";

export type { BackupsOptions } from "./backups/module.js";
export type { RedirectsOptions } from "./redirects/module.js";

const ID = "coywolf";
const VERSION = "0.1.0";
const PACKAGE = "@coywolf/emdash";

export interface CoywolfOptions {
	/** Full backups and restore. Omit or set false to disable. */
	backups?: BackupsOptions | false;
	/** Redirect manager. Omit or set false to disable. */
	redirects?: RedirectsOptions | false;
}

function adminSurfaces(options: CoywolfOptions) {
	const pages = [
		...(options.backups ? [{ path: "/backups", label: "Backups", icon: "database" }] : []),
		...(options.redirects ? [{ path: "/redirects", label: "Redirects", icon: "arrow-bend-up-right" }] : []),
	];
	const widgets = options.backups ? [{ id: "backup-status", title: "Backups", size: "third" as const }] : [];
	return { pages, widgets };
}

export function coywolfPlugin(options: CoywolfOptions = {}): PluginDescriptor<CoywolfOptions> {
	const { pages, widgets } = adminSurfaces(options);
	return {
		id: ID,
		version: VERSION,
		format: "native",
		entrypoint: PACKAGE,
		adminEntry: `${PACKAGE}/admin`,
		options,
		adminPages: pages,
		adminWidgets: widgets,
	};
}

/** Scheduled jobs need far longer than EmDash's 5-second hook default (Workers cron allows 15 minutes). */
const CRON_TIMEOUT_MS = 14 * 60_000;

export function createPlugin(options: CoywolfOptions = {}) {
	const backups = options.backups ? backupsModule(options.backups) : null;
	const redirects = options.redirects ? redirectsModule(options.redirects) : null;
	const { pages, widgets } = adminSurfaces(options);

	return definePlugin({
		id: ID,
		version: VERSION,
		admin: {
			entry: `${PACKAGE}/admin`,
			pages,
			widgets,
			settingsSchema: backups ? backupsSettingsSchema : {},
		},
		hooks: {
			// Config-registered native plugins don't get activate hooks at boot, so
			// the backups routes also ensure the task exists.
			"plugin:activate": {
				handler: async (_event, ctx) => {
					if (backups) await ensureBackupsTask(ctx);
				},
			},
			cron: {
				timeout: CRON_TIMEOUT_MS,
				handler: async (event, ctx) => {
					if (event.name === BACKUPS_TASK && backups) await backups.daily(ctx);
				},
			},
		},
		routes: {
			...(backups?.routes ?? {}),
			...(redirects?.routes ?? {}),
		},
	});
}

export default createPlugin;
