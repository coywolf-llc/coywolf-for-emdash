/**
 * Astro components for the pack's Portable Text blocks, auto-merged into
 * EmDash's <PortableText> (componentsEntry). Keys are block types. Each
 * component checks its feature switch and renders nothing (or EmDash's own
 * renderer) when it's off.
 */
import CodeBlock from "./codeBlocks/CodeBlock.astro";
import FileCard from "./files/FileCard.astro";
import BreadcrumbsComponent from "./headings/Breadcrumbs.astro";
import BreadcrumbsBlock from "./headings/BreadcrumbsBlock.astro";
import HeadingBlock from "./headings/HeadingBlock.astro";
import TableOfContents from "./headings/TableOfContents.astro";
import CoywolfVideo from "./videos/CoywolfVideo.astro";
import CoywolfReview from "./reviews/CoywolfReview.astro";
import Review from "./reviews/Review.astro";

export const blockComponents = {
	"coywolf-toc": TableOfContents,
	"coywolf-breadcrumbs": BreadcrumbsBlock,
	code: CodeBlock,
	"coywolf-file": FileCard,
	"coywolf-video": CoywolfVideo,
	"coywolf-review": CoywolfReview,
};

/** Videos module: the Stream player, for theme code. */
export { CoywolfVideo };

/** Breadcrumb trail for theme layouts (Headings & TOC module). */
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
