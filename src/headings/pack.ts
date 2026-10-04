/**
 * Headings & TOC module: heading anchors, a Table of Contents block and a
 * Breadcrumbs block, ported from Coywolf SEO. Anchors, TOC heading lists and
 * breadcrumb titles are stamped into the content on save (see ./stamp.ts);
 * the Astro components in src/astro/headings render them.
 */
import type { PluginContext } from "emdash";
import { definePluginRoute } from "emdash";
import { z } from "zod";

import { ctxFeatures, isOn, registerFeatures } from "../core/features.js";
import type { PackModule } from "../core/module.js";
import { parseInput } from "../shared.js";
import { capturePage } from "./breadcrumbs.js";
import { SETTINGS_KEY, invalidateHeadingsSettings, normalizeSettings } from "./settings.js";
import { BREADCRUMBS_BLOCK, TOC_BLOCK, needsPrevious, stampContent } from "./stamp.js";

/** No build-time options yet: defaults live on the Headings & TOC settings page. */
export type HeadingsOptions = Record<string, never>;

export const FEATURES = [
	{
		id: "headings",
		label: "Headings & TOC",
		description: "Linkable headings, a Table of Contents block, and a Breadcrumbs block.",
		default: false,
	},
	{
		id: "headings.anchors",
		label: "Heading anchors",
		description: "Give every H2–H6 a stable id (e.g. #jump-pricing) so sections can be linked, with an optional copy-link button.",
		default: false,
	},
	{
		id: "headings.toc",
		label: "Table of Contents block",
		description: "A Table of Contents block built from the entry's headings, with numbered or bulleted lists and an optional collapsible panel.",
		default: false,
	},
	{
		id: "headings.breadcrumbs",
		label: "Breadcrumbs",
		description: "An accessible breadcrumb trail, as a block and as a component for themes.",
		default: false,
	},
];
registerFeatures(FEATURES);

const LEVEL_OPTIONS = [2, 3, 4, 5, 6].map((n) => ({ label: `H${n}`, value: String(n) }));

const BLOCKS = [
	{
		type: TOC_BLOCK,
		label: "Table of Contents",
		icon: "list",
		category: "Sections",
		description: "A linked list of this entry's headings",
		fields: [
			{ type: "text_input", action_id: "title", label: "Title", placeholder: "Site default (Table of contents)" },
			{ type: "checkbox", action_id: "levels", label: "Heading levels (none checked: site default)", options: LEVEL_OPTIONS },
			{
				type: "select",
				action_id: "listStyle",
				label: "List style",
				options: [
					{ label: "Site default", value: "" },
					{ label: "Plain", value: "none" },
					{ label: "Bulleted", value: "bulleted" },
					{ label: "Numbered", value: "numbered" },
				],
			},
			{
				type: "select",
				action_id: "display",
				label: "Display",
				options: [
					{ label: "Site default", value: "" },
					{ label: "Always open", value: "open" },
					{ label: "Collapsible, open", value: "collapsible" },
					{ label: "Collapsible, collapsed", value: "collapsed" },
				],
			},
		],
	},
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

async function beforeSave(event: { content: Record<string, unknown>; collection: string; isNew: boolean; id?: string }, ctx: PluginContext) {
	const features = await ctxFeatures(ctx);
	const toc = isOn(features, "headings.toc");
	const anchors = isOn(features, "headings.anchors") || toc;
	const breadcrumbs = isOn(features, "headings.breadcrumbs");
	if (!anchors && !breadcrumbs) return undefined;

	const settings = normalizeSettings(await ctx.settings.get(SETTINGS_KEY));
	let previous: Record<string, unknown> | null = null;
	if (anchors && !event.isNew && event.id && ctx.content && needsPrevious(event.content)) {
		try {
			previous = (await ctx.content.get(event.collection, event.id))?.data ?? null;
		} catch (error) {
			ctx.log.warn("headings: could not read the previous version; anchors follow the heading text", { error: String(error) });
		}
	}
	return stampContent(event.content, { anchors, toc, breadcrumbs, prefix: settings.prefix, previous }) ?? undefined;
}

export function headingsPack(_options: HeadingsOptions): PackModule {
	return {
		id: "headings",
		label: "Headings & TOC",
		features: FEATURES,
		capabilities: ["content:read"],
		portableTextBlocks: BLOCKS,
		adminPages: [{ path: "/headings", label: "Headings & TOC", icon: "list" }],
		hooks: {
			"content:beforeSave": beforeSave,
			// Remember the theme's breadcrumb trail for the Breadcrumbs block in the body.
			"page:metadata": (event: { page: Parameters<typeof capturePage>[0] }) => {
				capturePage(event.page);
				return [];
			},
		},
		hookFeature: { "page:metadata": "headings.breadcrumbs" },
		routes: {
			"headings/settings": {
				permission: "plugins:manage" as const,
				handler: async (ctx: PluginContext) => ({ settings: normalizeSettings(await ctx.settings.get(SETTINGS_KEY)) }),
			},
			"headings/settings/save": definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "json" },
				handler: async (ctx) => {
					const settings = normalizeSettings(parseInput(settingsInput, ctx.input).settings);
					await ctx.settings.set(SETTINGS_KEY, settings);
					invalidateHeadingsSettings();
					ctx.log.info("Heading settings saved");
					return { settings };
				},
			}),
		},
	};
}
