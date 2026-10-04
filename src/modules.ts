/**
 * The module list. Order matters: hooks and middleware run in this order.
 * To add a module: import its factory and middleware, then add one entry to
 * MODULES (and MIDDLEWARE if it serves site URLs).
 */
import { backupsPack } from "./backups/pack.js";
import type { PackMiddleware, PackModule } from "./core/module.js";
import { redirectsMiddleware, redirectsPack } from "./redirects/pack.js";
import type { CoywolfOptions } from "./options.js";

type Factory = (options: CoywolfOptions) => PackModule | null;

export const MODULES: Factory[] = [
	(o) => (o.backups ? backupsPack(o.backups) : null),
	(o) => (o.redirects === false ? null : redirectsPack(o.redirects ?? {})),
];

export const MIDDLEWARE: PackMiddleware[] = [redirectsMiddleware];
