/**
 * Astro components for the pack's Portable Text blocks, auto-merged into
 * EmDash's <PortableText> (componentsEntry). Keys are block types. Each
 * component checks its feature switch and renders nothing (or EmDash's own
 * renderer) when it's off.
 */
import BreadcrumbsComponent from "./headings/Breadcrumbs.astro";
import BreadcrumbsBlock from "./headings/BreadcrumbsBlock.astro";
import HeadingBlock from "./headings/HeadingBlock.astro";
import TableOfContents from "./headings/TableOfContents.astro";

export const blockComponents = {
	"coywolf-toc": TableOfContents,
	"coywolf-breadcrumbs": BreadcrumbsBlock,
};

/** Breadcrumb trail for theme layouts (Headings & TOC module). */
export { BreadcrumbsComponent as Breadcrumbs };

/**
 * Pass to <PortableText components={...}> so headings get their anchor ids
 * (Headings & TOC module). Plugins can't override EmDash's `block` renderer.
 */
export const portableTextComponents = { block: HeadingBlock };
