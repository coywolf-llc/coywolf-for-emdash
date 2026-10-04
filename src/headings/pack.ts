/**
 * Headings & TOC module: heading anchors and a Table of Contents block,
 * ported from Coywolf SEO. Anchors and TOC heading lists are stamped into the
 * content on save (see ./stamp.ts); the Astro components in
 * src/astro/headings render them. Breadcrumbs moved to their own module
 * (Breadcrumb Nav, src/breadcrumbs) in 0.6.0.
 */
import type { PluginContext } from "emdash";
import { definePluginRoute } from "emdash";
import { z } from "zod";

import { ctxFeatures, isOn, registerFeatures } from "../core/features.js";
import type { PackModule } from "../core/module.js";
import { parseInput } from "../shared.js";
import { SETTINGS_KEY, invalidateHeadingsSettings, normalizeSettings, withLegacyBreadcrumbs } from "./settings.js";
import { TOC_BLOCK, needsPrevious, stampContent } from "./stamp.js";

/** No build-time options yet: defaults live on the Headings & TOC settings page. */
export type HeadingsOptions = Record<string, never>;

export const FEATURES = [
	{
		id: "headings",
		label: "Headings & TOC",
		description: "Linkable headings and a Table of Contents block.",
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
			{
				type: "select",
				action_id: "showTitle",
				label: "Show title",
				options: [
					{ label: "Site default", value: "" },
					{ label: "Show", value: "show" },
					{ label: "Hide (collapsible tables keep it as the toggle)", value: "hide" },
				],
			},
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
];

const settingsInput = z.object({ settings: z.record(z.string(), z.unknown()) });

async function beforeSave(event: { content: Record<string, unknown>; collection: string; isNew: boolean; id?: string }, ctx: PluginContext) {
	const features = await ctxFeatures(ctx);
	const toc = isOn(features, "headings.toc");
	const anchors = isOn(features, "headings.anchors") || toc;
	if (!anchors) return undefined;

	const settings = normalizeSettings(await ctx.settings.get(SETTINGS_KEY));
	let previous: Record<string, unknown> | null = null;
	if (anchors && !event.isNew && event.id && ctx.content && needsPrevious(event.content)) {
		try {
			previous = (await ctx.content.get(event.collection, event.id))?.data ?? null;
		} catch (error) {
			ctx.log.warn("headings: could not read the previous version; anchors follow the heading text", { error: String(error) });
		}
	}
	return stampContent(event.content, { anchors, toc, prefix: settings.prefix, previous }) ?? undefined;
}

export function headingsPack(_options: HeadingsOptions): PackModule {
	return {
		id: "headings",
		label: "Headings & TOC",
		features: FEATURES,
		capabilities: ["content:read", "content:write"],
		portableTextBlocks: BLOCKS,
		adminPages: [{ path: "/headings", label: "Headings & TOC", icon: "list" }],
		hooks: {
			"content:beforeSave": beforeSave,
		},
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
					await ctx.settings.set(SETTINGS_KEY, withLegacyBreadcrumbs(await ctx.settings.get(SETTINGS_KEY), settings));
					invalidateHeadingsSettings();
					ctx.log.info("Heading settings saved");
					return { settings };
				},
			}),
		},
	};
}
