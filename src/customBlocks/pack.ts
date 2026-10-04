/**
 * Custom Blocks module (named after Coywolf's WordPress plugin, Custom
 * Blocks; called Content Blocks until 0.12.0): editor blocks rendered by the
 * pack's Astro components (src/astro/customBlocks), each behind its own switch:
 *
 * - Note: a callout (Note, Editor's note, Tip, Warning) in an <aside>;
 * - Details: native <details>/<summary> (EmDash's HTML sanitizer strips them
 *   from HTML blocks), with a Transcript style for long transcripts;
 * - Affiliate disclosure: the site's wording (set on the Custom Blocks page),
 *   or the block's own;
 * - Quote: a blockquote with a citation and source URL;
 * - Testimonial: a quote with the person's name, title and headshot;
 * - Podcast links: where to listen (Apple Podcasts, Spotify, …), set once for
 *   the site on the Custom Blocks page, or per block.
 *
 * The feature ids were contentBlocks* until 0.12.0; FeatureDef.replaces
 * carries saved switches over. Block types and the disclosure setting's
 * storage key are unchanged.
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
import type { FeatureDef } from "../core/module.js";
import {
	BLOCK_TYPES,
	DEFAULT_DISCLOSURE,
	DEFAULT_PODCAST,
	DETAILS_VARIANTS,
	DISCLOSURE_KINDS,
	MAX_DISCLOSURE_TEXT,
	NOTE_VARIANTS,
	PODCAST_HEADING_TAGS,
	PODCAST_SERVICES,
	normalizeDisclosureSettings,
	normalizePodcastSettings,
} from "./render.js";
import { PODCAST_SETTINGS_KEY, SETTINGS_KEY, invalidateCustomBlockSettings } from "./settings.js";

export const F = {
	main: "customBlocks",
	note: "customBlocks.note",
	details: "customBlocks.details",
	disclosure: "customBlocks.disclosure",
	quote: "customBlocks.quote",
	testimonial: "customBlocks.testimonial",
	podcast: "customBlocks.podcast",
} as const;

export const FEATURES: FeatureDef[] = [
	{
		id: F.main,
		label: "Custom Blocks",
		description: "Extra editor blocks for notes, expandable details, affiliate disclosures, quotes, testimonials and podcast links.",
		default: false,
		replaces: ["contentBlocks"],
	},
	{ id: F.note, label: "Note block", description: "A callout set apart from the text: Note, Editor's note, Tip or Warning.", default: false, replaces: ["contentBlocks.note"] },
	{
		id: F.details,
		label: "Details block",
		description: "A section that opens and closes (summary and hidden text), with a Transcript style.",
		default: false,
		replaces: ["contentBlocks.details"],
	},
	{
		id: F.disclosure,
		label: "Affiliate disclosure block",
		description: "Your affiliate or Amazon Associates disclosure, worded once for the whole site.",
		default: false,
		replaces: ["contentBlocks.disclosure"],
	},
	{ id: F.quote, label: "Quote block", description: "A quotation with who said it and a link to the source.", default: false, replaces: ["contentBlocks.quote"] },
	{ id: F.testimonial, label: "Testimonial block", description: "What someone said about you, with their name, title and photo.", default: false },
	{ id: F.podcast, label: "Podcast links block", description: "Links to your podcast on Apple Podcasts, Spotify, YouTube and other apps, set once for the site.", default: false },
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
				placeholder: "Leave empty to use the site's wording (Custom Blocks page)",
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
	{
		type: BLOCK_TYPES.testimonial,
		label: "Testimonial",
		icon: "chat-centered-text",
		category: "Content",
		description: "What someone said, with their name, title and photo",
		fields: [
			{ type: "text_input", action_id: "quote", label: "What they said", multiline: true, placeholder: TEXT_HELP },
			{ type: "text_input", action_id: "name", label: "Name" },
			{ type: "text_input", action_id: "title", label: "Title (optional)", placeholder: "e.g. Founder of Example Co." },
			{ type: "media_picker", action_id: "photo", label: "Photo (optional)", mime_type_filter: "image/" },
			{ type: "text_input", action_id: "nameUrl", label: "Link for the name (optional, https://…)", placeholder: "Their website or social profile" },
			{ type: "text_input", action_id: "titleUrl", label: "Link for the title (optional, https://…)", placeholder: "Their company's website" },
		],
	},
	{
		type: BLOCK_TYPES.podcast,
		label: "Podcast links",
		icon: "microphone",
		category: "Content",
		description: "Where to listen: Apple Podcasts, Spotify, RSS and more",
		fields: [
			{
				type: "select",
				action_id: "source",
				label: "Links",
				options: [
					{ value: "site", label: "The site's podcast (Custom Blocks page)" },
					{ value: "block", label: "Only the links below" },
				],
				initial_value: "site",
			},
			{ type: "text_input", action_id: "heading", label: "Heading (optional)", placeholder: "Leave empty to use the site's heading" },
			...PODCAST_SERVICES.map(([id, label]) => ({
				type: "text_input",
				action_id: id,
				label: `${label} link (only with “Only the links below”)`,
				placeholder: "https://…",
			})),
		],
	},
];

const settingsInput = z.object({
	affiliateText: z.string().max(MAX_DISCLOSURE_TEXT, `Keep the wording under ${MAX_DISCLOSURE_TEXT} characters.`),
	amazonText: z.string().max(MAX_DISCLOSURE_TEXT, `Keep the wording under ${MAX_DISCLOSURE_TEXT} characters.`),
	linkUrl: z.string().max(2000),
	linkText: z.string().max(100),
});

const podcastInput = z.object({
	heading: z.string().max(200, "Keep the heading under 200 characters."),
	headingTag: z.enum(PODCAST_HEADING_TAGS),
	showIcons: z.boolean(),
	links: z.record(z.string(), z.string().max(2000)),
});

export function customBlocksPack(): PackModule {
	return {
		id: "customBlocks",
		label: "Custom Blocks",
		features: FEATURES,
		portableTextBlocks: BLOCKS,
		adminPages: [{ path: "/custom-blocks", label: "Custom Blocks", icon: "squares-four" }],
		routes: {
			"customBlocks/settings": {
				permission: "plugins:manage" as const,
				handler: async (ctx: PluginContext) => ({
					settings: normalizeDisclosureSettings(await ctx.settings.get(SETTINGS_KEY)),
					defaults: DEFAULT_DISCLOSURE,
					podcast: normalizePodcastSettings(await ctx.settings.get(PODCAST_SETTINGS_KEY)),
					podcastDefaults: DEFAULT_PODCAST,
				}),
			},
			"customBlocks/settings/save": definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "json" },
				handler: async (ctx) => {
					const input = parseInput(settingsInput, ctx.input);
					const settings = normalizeDisclosureSettings(input);
					if (input.linkUrl.trim() && !settings.linkUrl) throw PluginRouteError.badRequest("Use a link like https://example.com/disclosures/ or /disclosures/.");
					await ctx.settings.set(SETTINGS_KEY, settings);
					invalidateCustomBlockSettings();
					ctx.log.info("Custom block settings saved");
					return { settings };
				},
			}),
			"customBlocks/podcast/save": definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "json" },
				handler: async (ctx) => {
					const input = parseInput(podcastInput, ctx.input);
					const podcast = normalizePodcastSettings(input);
					const bad = PODCAST_SERVICES.find(([id]) => (input.links[id] ?? "").trim() && !podcast.links[id]);
					if (bad) throw PluginRouteError.badRequest(`The ${bad[1]} link isn't a web address. Use one like https://example.com/… (or /feed.xml for the RSS feed).`);
					await ctx.settings.set(PODCAST_SETTINGS_KEY, podcast);
					invalidateCustomBlockSettings();
					ctx.log.info("Podcast links saved");
					return { podcast };
				},
			}),
		},
	};
}
