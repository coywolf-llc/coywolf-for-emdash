import type { BackupsOptions } from "./backups/module.js";
import type { HeadingsOptions } from "./headings/pack.js";
import type { CodeBlocksOptions } from "./codeBlocks/pack.js";
import type { RedirectsOptions } from "./redirects/module.js";

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
}
