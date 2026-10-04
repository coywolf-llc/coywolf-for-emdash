import type { PluginContext } from "emdash";

import { registerFeatures } from "../core/features.js";
import type { PackModule } from "../core/module.js";
import { BACKUPS_TASK, type BackupsOptions, backupsModule } from "./module.js";

const FEATURES = [
	{ id: "backups", label: "Backups", description: "Database and media backups, rewind, and restore.", default: true },
];
registerFeatures(FEATURES);

export function backupsPack(options: BackupsOptions): PackModule {
	const backups = backupsModule(options);
	return {
		id: "backups",
		label: "Backups",
		features: FEATURES,
		routes: backups.routes,
		tasks: [{ name: BACKUPS_TASK, schedule: "@daily", handler: (ctx: PluginContext) => backups.daily(ctx) }],
		adminPages: [{ path: "/backups", label: "Backups", icon: "database" }],
		widgets: [{ id: "backup-status", title: "Backups", size: "third" }],
	};
}
