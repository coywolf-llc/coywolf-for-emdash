/**
 * Content Blocks module: four editor blocks rendered by the pack's Astro
 * components (src/astro/contentBlocks), each behind its own switch:
 *
 * - Note: a callout (Note, Editor's note, Tip, Warning) in an <aside>;
 * - Details: native <details>/<summary> (EmDash's HTML sanitizer strips them
 *   from HTML blocks), with a Transcript style for long transcripts;
 * - Affiliate disclosure: the site's wording (set on the Content Blocks page),
 *   or the block's own;
 * - Quote: a blockquote with a citation and source URL.
 *
 * Text fields take simple markup (see ./rich.ts). Markup and CSS live in
 * ./render.ts, shared with the admin previews.
 */
import type { PluginContext } from "emdash";
import { PluginRouteError, definePluginRoute } from "emdash";
import { z } from "zod";

import { registerFeatures } from "../core/features.js";
import type { PackModule } from "../core/module.js";
import { parseInput } from "../shared.js";
import { BLOCK_TYPES, DEFAULT_DISCLOSURE, DETAILS_VARIANTS, DISCLOSURE_KINDS, MAX_DISCLOSURE_TEXT, NOTE_VARIANTS, normalizeDisclosureSettings } from "./render.js";
import { SETTINGS_KEY, invalidateContentBlockSettings } from "./settings.js";

export const F = {
	main: "contentBlocks",
	note: "contentBlocks.note",
	details: "contentBlocks.details",
	disclosure: "contentBlocks.disclosure",
	quote: "contentBlocks.quote",
} as const;

export const FEATURES = [
	{ id: F.main, label: "Content Blocks", description: "Extra editor blocks for notes, expandable details, affiliate disclosures and quotes.", default: false },
	{ id: F.note, label: "Note block", description: "A callout set apart from the text: Note, Editor's note, Tip or Warning.", default: false },
	{ id: F.details, label: "Details block", description: "A section that opens and closes (summary and hidden text), with a Transcript style.", default: false },
	{ id: F.disclosure, label: "Affiliate disclosure block", description: "Your affiliate or Amazon Associates disclosure, worded once for the whole site.", default: false },
	{ id: F.quote, label: "Quote block", description: "A quotation with who said it and a link to the source.", default: false },
];
registerFeatures(FEATURES);

const TEXT_HELP = "Blank line = new paragraph. [link text](https://…) and **bold** work, and simple HTML.";

const BLOCKS = [
	{
		type: BLOCK_TYPES.note,
		label: "Note",
		icon: "info",
		category: "Content",
		description: "A callout: note, editor's note, tip or warning",
		fields: [
			{ type: "select", action_id: "variant", label: "Kind", options: NOTE_VARIANTS.map(([value, label]) => ({ value, label })), initial_value: "note" },
			{ type: "text_input", action_id: "title", label: "Title (optional)", placeholder: "Leave empty to use the kind, e.g. Note" },
			{ type: "toggle", action_id: "hideTitle", label: "Hide the title" },
			{
				type: "select",
				action_id: "titleTag",
				label: "Title style",
				options: [
					{ value: "p", label: "Bold text" },
					{ value: "h2", label: "Heading 2" },
					{ value: "h3", label: "Heading 3" },
					{ value: "h4", label: "Heading 4" },
				],
				initial_value: "p",
			},
			{ type: "text_input", action_id: "body", label: "Text", multiline: true, placeholder: TEXT_HELP },
		],
	},
	{
		type: BLOCK_TYPES.details,
		label: "Details",
		icon: "caret-circle-down",
		category: "Content",
		description: "A summary that opens to show more, or a transcript",
		fields: [
			{ type: "select", action_id: "variant", label: "Style", options: DETAILS_VARIANTS.map(([value, label]) => ({ value, label })), initial_value: "details" },
			{ type: "text_input", action_id: "summary", label: "Summary (always shown)", placeholder: "e.g. Read the transcript" },
			{ type: "text_input", action_id: "body", label: "Hidden text", multiline: true, placeholder: TEXT_HELP },
			{ type: "toggle", action_id: "open", label: "Open when the page loads" },
		],
	},
	{
		type: BLOCK_TYPES.disclosure,
		label: "Affiliate disclosure",
		icon: "currency-dollar",
		category: "Content",
		description: "The site's affiliate link disclosure",
		fields: [
			{ type: "select", action_id: "kind", label: "Disclosure", options: DISCLOSURE_KINDS.map(([value, label]) => ({ value, label })), initial_value: "affiliate" },
			{
				type: "text_input",
				action_id: "text",
				label: "Wording for this page (optional)",
				multiline: true,
				placeholder: "Leave empty to use the site's wording (Content Blocks page)",
			},
		],
	},
	{
		type: BLOCK_TYPES.quote,
		label: "Quote",
		icon: "quotes",
		category: "Content",
		description: "A quotation with its source",
		fields: [
			{ type: "text_input", action_id: "quote", label: "Quote", multiline: true, placeholder: TEXT_HELP },
			{ type: "text_input", action_id: "citation", label: "Who said it (optional)", placeholder: "Name, title, [where](https://…)" },
			{ type: "text_input", action_id: "sourceUrl", label: "Source URL (optional, https://…)" },
		],
	},
];

const settingsInput = z.object({
	affiliateText: z.string().max(MAX_DISCLOSURE_TEXT, `Keep the wording under ${MAX_DISCLOSURE_TEXT} characters.`),
	amazonText: z.string().max(MAX_DISCLOSURE_TEXT, `Keep the wording under ${MAX_DISCLOSURE_TEXT} characters.`),
	linkUrl: z.string().max(2000),
	linkText: z.string().max(100),
});

export function contentBlocksPack(): PackModule {
	return {
		id: "contentBlocks",
		label: "Content Blocks",
		features: FEATURES,
		portableTextBlocks: BLOCKS,
		adminPages: [{ path: "/content-blocks", label: "Content Blocks", icon: "squares-four" }],
		routes: {
			"contentBlocks/settings": {
				permission: "plugins:manage" as const,
				handler: async (ctx: PluginContext) => ({
					settings: normalizeDisclosureSettings(await ctx.settings.get(SETTINGS_KEY)),
					defaults: DEFAULT_DISCLOSURE,
				}),
			},
			"contentBlocks/settings/save": definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "json" },
				handler: async (ctx) => {
					const input = parseInput(settingsInput, ctx.input);
					const settings = normalizeDisclosureSettings(input);
					if (input.linkUrl.trim() && !settings.linkUrl) throw PluginRouteError.badRequest("Use a link like https://example.com/disclosures/ or /disclosures/.");
					await ctx.settings.set(SETTINGS_KEY, settings);
					invalidateContentBlockSettings();
					ctx.log.info("Content block settings saved");
					return { settings };
				},
			}),
		},
	};
}
