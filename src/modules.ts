/**
 * The module list. Order matters: hooks and middleware run in this order.
 * To add a module: import its factory and middleware, then add one entry to
 * MODULES (and MIDDLEWARE if it serves site URLs).
 */
import { aiPack } from "./ai/pack.js";
import { backupsPack } from "./backups/pack.js";
import { codeBlocksPack } from "./codeBlocks/pack.js";
import type { PackMiddleware, PackModule } from "./core/module.js";
import { headingsPack } from "./headings/pack.js";
import { filesMiddleware, filesPack } from "./files/pack.js";
import { discoveryMiddleware, discoveryPack } from "./discovery/pack.js";
import { linksPack } from "./links/pack.js";
import { redirectsMiddleware, redirectsPack } from "./redirects/pack.js";
import { schemaPack } from "./schema/pack.js";
import { searchPack, searchRateLimitMiddleware } from "./search/pack.js";
import { robotsMiddleware, robotsPack } from "./robots/pack.js";
import { reviewsPack } from "./reviews/pack.js";
import type { CoywolfOptions } from "./options.js";
import { videosCaptionsMiddleware, videosPack, videosSitemapMiddleware } from "./videos/pack.js";

type Factory = (options: CoywolfOptions) => PackModule | null;

export const MODULES: Factory[] = [
	(o) => (o.backups ? backupsPack(o.backups) : null),
	(o) => (o.redirects === false ? null : redirectsPack(o.redirects ?? {})),
	(o) => (o.headings === false ? null : headingsPack(o.headings ?? {})),
	(o) => (o.codeBlocks === false ? null : codeBlocksPack(o.codeBlocks ?? {})),
	(o) => (o.schema === false ? null : schemaPack(o.schema ?? {})),
	(o) => (o.files === false ? null : filesPack(o.files ?? {})),
	(o) => (o.search === false ? null : searchPack(o.search ?? {})),
	(o) => (o.ai === false ? null : aiPack(o.ai ?? {})),
	(o) => (o.discovery === false ? null : discoveryPack(o.discovery ?? {})),
	(o) => (o.links === false ? null : linksPack()),
	(o) => (o.videos === false ? null : videosPack(o.videos ?? {})),
	(o) => (o.robots === false ? null : robotsPack(o.robots ?? {})),
	(o) => (o.reviews === false ? null : reviewsPack(o.reviews ?? {})),
];

export const MIDDLEWARE: PackMiddleware[] = [redirectsMiddleware, robotsMiddleware, filesMiddleware, searchRateLimitMiddleware, ...discoveryMiddleware, videosSitemapMiddleware, videosCaptionsMiddleware];
