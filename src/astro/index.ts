/**
 * Astro components for the pack's Portable Text blocks, auto-merged into
 * EmDash's <PortableText> (componentsEntry). Keys are block types. Each
 * component checks its feature switch and renders nothing (or EmDash's own
 * renderer) when it's off.
 */
import CodeBlock from "./codeBlocks/CodeBlock.astro";
import FileCard from "./files/FileCard.astro";
import BreadcrumbsComponent from "./breadcrumbs/Breadcrumbs.astro";
import BreadcrumbsBlock from "./breadcrumbs/BreadcrumbsBlock.astro";
import HeadingBlock from "./headings/HeadingBlock.astro";
import TableOfContents from "./headings/TableOfContents.astro";
import CoywolfVideo from "./videos/CoywolfVideo.astro";
import CoywolfReview from "./reviews/CoywolfReview.astro";
import Review from "./reviews/Review.astro";
import Note from "./customBlocks/Note.astro";
import Details from "./customBlocks/Details.astro";
import Disclosure from "./customBlocks/Disclosure.astro";
import Quote from "./customBlocks/Quote.astro";
import Testimonial from "./customBlocks/Testimonial.astro";
import Podcast from "./customBlocks/Podcast.astro";

export const blockComponents = {
	"coywolf-toc": TableOfContents,
	"coywolf-breadcrumbs": BreadcrumbsBlock,
	code: CodeBlock,
	"coywolf-file": FileCard,
	"coywolf-video": CoywolfVideo,
	"coywolf-review": CoywolfReview,
	"coywolf-note": Note,
	"coywolf-details": Details,
	"coywolf-disclosure": Disclosure,
	"coywolf-quote": Quote,
	"coywolf-testimonial": Testimonial,
	"coywolf-podcast": Podcast,
};

/** Videos module: the Stream player, for theme code. */
export { CoywolfVideo };

/** Breadcrumb trail for theme layouts (Breadcrumb Nav module). */
export { BreadcrumbsComponent as Breadcrumbs };

/**
 * Pass to <PortableText components={...}> so headings get their anchor ids
 * (Headings & TOC module). Plugins can't override EmDash's `block` renderer.
 */
export const portableTextComponents = { block: HeadingBlock };
/** Search module: the SearchBox component and OR-fallback search for site search pages. */
export { default as SearchBox } from "./search/SearchBox.astro";
export { searchWithFallback } from "../search/query.js";
export type { PackSearchOptions, PackSearchResponse, PackSearchResult } from "../search/query.js";
export { entryUrl, entryUrls, matchEntryPath } from "../core/content-url.js";
export type { EntryRef, MatchedEntry } from "../core/content-url.js";
/** Reviews module: the review box for theme code, and legacy WordPress review marker attrs → review fields. */
export { Review };
export { reviewFromAttrs } from "../reviews/lib.js";

/**
 * Clean Image URLs module: cleanImageUrl builds resized-image URLs for theme
 * images (on the media host when one is set, else /media/<id>-<w>x<h>.<format>;
 * null when off); originalImageUrl (alias mediaUrl) gives the original file
 * on the media host (falls back to the source).
 */
export { cleanImageUrl, mediaUrl, originalImageUrl } from "../images/pack.js";
export { cleanImagePath, mediaFile } from "../images/lib.js";
