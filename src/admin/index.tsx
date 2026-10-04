import type { PluginAdminExports } from "emdash";

import { BackupStatusWidget, BackupsPage } from "./backups.js";
import { FeaturesPage } from "./features.js";
import { RedirectsPage } from "./redirects.js";

export const pages: PluginAdminExports["pages"] = {
	"/features": FeaturesPage,
	"/backups": BackupsPage,
	"/redirects": RedirectsPage,
};

export const widgets: PluginAdminExports["widgets"] = {
	"backup-status": BackupStatusWidget,
};
