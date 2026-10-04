import type { PluginAdminExports } from "emdash";

import { BackupStatusWidget, BackupsPage } from "./backups.js";
import { CodeBlocksPage } from "./codeBlocks.js";
import { FeaturesPage } from "./features.js";
import { HeadingsPage } from "./headings.js";
import { RedirectsPage } from "./redirects.js";
import { SchemaPage } from "./schema.js";

export const pages: PluginAdminExports["pages"] = {
	"/features": FeaturesPage,
	"/backups": BackupsPage,
	"/redirects": RedirectsPage,
	"/headings": HeadingsPage,
	"/code-blocks": CodeBlocksPage,
	"/schema": SchemaPage,
};

export const widgets: PluginAdminExports["widgets"] = {
	"backup-status": BackupStatusWidget,
};
