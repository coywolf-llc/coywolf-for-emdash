/**
 * Breadcrumb Nav module: an accessible breadcrumb trail as a Portable Text
 * block (`coywolf-breadcrumbs`) and as a theme component (`Breadcrumbs` from
 * "@coywolf/emdash/astro"). Until 0.6.0 this was the `headings.breadcrumbs`
 * sub-feature of Headings & TOC; the feature switch (FeatureDef.replaces) and
 * the settings (./settings.ts) fall back to the old stored values, and the
 * block type, component and stored data are unchanged.
 */
import type { PluginContext } from "emdash";
import { definePluginRoute } from "emdash";
import { z } from "zod";

import { registerFeatures } from "../core/features.js";
import type { FeatureDef, PackModule } from "../core/module.js";
import { parseInput } from "../shared.js";
import { SETTINGS_KEY, ctxBreadcrumbsSettings, invalidateBreadcrumbsSettings, normalizeSettings } from "./settings.js";
import { BREADCRUMBS_BLOCK, stampBreadcrumbs } from "./stamp.js";
import { capturePage } from "./trail.js";

/** No build-time options yet: defaults live on the Breadcrumb Nav page. */
export type BreadcrumbsOptions = Record<string, never>;

export const FEATURES: FeatureDef[] = [
	{
		id: "breadcrumbs",
		label: "Breadcrumb Nav",
		description: "An accessible breadcrumb trail, as a Breadcrumbs block and as a component for theme layouts.",
		default: false,
		replaces: ["headings.breadcrumbs"],
	},
];
registerFeatures(FEATURES);

const BLOCKS = [
	{
		type: BREADCRUMBS_BLOCK,
		label: "Breadcrumbs",
		icon: "link",
		category: "Sections",
		description: "A breadcrumb trail for this page",
		fields: [
			{
				type: "select",
				action_id: "separator",
				label: "Separator",
				options: [
					{ label: "Site default", value: "" },
					{ label: "/", value: "slash" },
					{ label: "›", value: "chevron" },
					{ label: "»", value: "guillemet" },
					{ label: "•", value: "bullet" },
					{ label: "→", value: "arrow" },
					{ label: ">", value: "gt" },
				],
			},
			{ type: "text_input", action_id: "homeLabel", label: "Home label", placeholder: "Site default (Home)" },
			{
				type: "select",
				action_id: "showCurrent",
				label: "Current page",
				options: [
					{ label: "Site default", value: "" },
					{ label: "Show", value: "show" },
					{ label: "Hide", value: "hide" },
				],
			},
		],
	},
];

const settingsInput = z.object({ settings: z.record(z.string(), z.unknown()) });

/** Stamp each Breadcrumbs block with the entry's title (its own hook, so it works with Headings & TOC off). */
export function beforeSave(event: { content: Record<string, unknown> }): Record<string, unknown> | undefined {
	return stampBreadcrumbs(event.content) ?? undefined;
}

export function breadcrumbsPack(_options: BreadcrumbsOptions): PackModule {
	return {
		id: "breadcrumbs",
		label: "Breadcrumb Nav",
		features: FEATURES,
		capabilities: ["content:write"],
		portableTextBlocks: BLOCKS,
		adminPages: [{ path: "/breadcrumbs", label: "Breadcrumb Nav", icon: "path" }],
		hooks: {
			"content:beforeSave": beforeSave,
			// Remember the theme's breadcrumb trail for the Breadcrumbs block in the body.
			"page:metadata": (event: { page: Parameters<typeof capturePage>[0] }) => {
				capturePage(event.page);
				return [];
			},
		},
		routes: {
			"breadcrumbs/settings": {
				permission: "plugins:manage" as const,
				handler: async (ctx: PluginContext) => ({ settings: await ctxBreadcrumbsSettings(ctx) }),
			},
			"breadcrumbs/settings/save": definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "json" },
				handler: async (ctx) => {
					const settings = normalizeSettings(parseInput(settingsInput, ctx.input).settings);
					await ctx.settings.set(SETTINGS_KEY, settings);
					invalidateBreadcrumbsSettings();
					ctx.log.info("Breadcrumb settings saved");
					return { settings };
				},
			}),
		},
	};
}
