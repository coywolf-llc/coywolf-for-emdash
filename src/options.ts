import type { AiOptions } from "./ai/store.js";
import type { BackupsOptions } from "./backups/module.js";
import type { HeadingsOptions } from "./headings/pack.js";
import type { CodeBlocksOptions } from "./codeBlocks/pack.js";
import type { FilesOptions } from "./files/module.js";
import type { DiscoveryOptions } from "./discovery/module.js";
import type { LinksOptions } from "./links/module.js";
import type { RedirectsOptions } from "./redirects/module.js";
import type { SchemaOptions } from "./schema/module.js";
import type { SearchOptions } from "./search/module.js";
import type { VideosOptions } from "./videos/module.js";

/**
 * Modules to include in the build. Backups needs its bindings, so it's
 * included only when configured; every other module is included unless set
 * to false. Included modules are then turned on or off on the Features page.
 */
export interface CoywolfOptions {
	backups?: BackupsOptions | false;
	redirects?: RedirectsOptions | false;
	headings?: HeadingsOptions | false;
	codeBlocks?: CodeBlocksOptions | false;
	schema?: SchemaOptions | false;
	files?: FilesOptions | false;
	search?: SearchOptions | false;
	ai?: AiOptions | false;
	discovery?: DiscoveryOptions | false;
	links?: LinksOptions | false;
	videos?: VideosOptions | false;
}
