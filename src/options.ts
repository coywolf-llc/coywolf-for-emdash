import type { AiOptions } from "./ai/store.js";
import type { BackupsOptions } from "./backups/module.js";
import type { HeadingsOptions } from "./headings/pack.js";
import type { BreadcrumbsOptions } from "./breadcrumbs/pack.js";
import type { CodeBlocksOptions } from "./codeBlocks/pack.js";
import type { FilesOptions } from "./files/module.js";
import type { DiscoveryOptions } from "./discovery/module.js";
import type { LinksOptions } from "./links/module.js";
import type { RedirectsOptions } from "./redirects/module.js";
import type { SchemaOptions } from "./schema/module.js";
import type { SearchOptions } from "./search/module.js";
import type { VideosOptions } from "./videos/module.js";
import type { RobotsOptions } from "./robots/module.js";
import type { ReviewsOptions } from "./reviews/pack.js";
import type { TrailingSlash } from "./core/content-url.js";

/**
 * Modules to include in the build. Backups needs its bindings, so it's
 * included only when configured; every other module is included unless set
 * to false. Included modules are then turned on or off on the Coywolf Pack page.
 */
export interface CoywolfOptions {
	backups?: BackupsOptions | false;
	redirects?: RedirectsOptions | false;
	headings?: HeadingsOptions | false;
	breadcrumbs?: BreadcrumbsOptions | false;
	codeBlocks?: CodeBlocksOptions | false;
	schema?: SchemaOptions | false;
	files?: FilesOptions | false;
	search?: SearchOptions | false;
	ai?: AiOptions | false;
	discovery?: DiscoveryOptions | false;
	links?: LinksOptions | false;
	videos?: VideosOptions | false;
	robots?: RobotsOptions | false;
	reviews?: ReviewsOptions | false;
	/** Custom Blocks: Note, Details, Affiliate disclosure, Quote, Testimonial and Podcast links blocks (no options yet). `false` leaves the module out. */
	customBlocks?: Record<string, never> | false;
	/** @deprecated Until 0.12.0 the Custom Blocks module was called Content Blocks; `contentBlocks: false` still leaves it out. */
	contentBlocks?: Record<string, never> | false;
	/** WordPress import tools (no options yet). `false` leaves the module out. */
	wpImport?: Record<string, never> | false;
	/**
	 * Entry URL patterns for collections the theme routes differently from
	 * EmDash's url_pattern, e.g. `{ posts: "/{term:category|uncategorized}/{slug}/" }`.
	 * Used by every module that builds entry URLs (see README, "Content URLs").
	 */
	urls?: Record<string, string>;
	/** Trailing-slash policy for entry URLs. Default: EmDash's (Astro's `trailingSlash`). */
	trailingSlash?: TrailingSlash;
}
