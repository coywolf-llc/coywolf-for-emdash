import type { PluginAdminExports } from "emdash";

import { AiPage } from "./ai.js";
import { BackupStatusWidget, BackupsPage } from "./backups.js";
import { CodeBlocksPage } from "./codeBlocks.js";
import { FeaturesPage } from "./features.js";
import { HeadingsPage } from "./headings.js";
import { FilesPage } from "./files.js";
import { RedirectsPage } from "./redirects.js";
import { SchemaPage } from "./schema.js";
import { SearchPage } from "./search.js";

export const pages: PluginAdminExports["pages"] = {
	"/features": FeaturesPage,
	"/backups": BackupsPage,
	"/redirects": RedirectsPage,
	"/headings": HeadingsPage,
	"/code-blocks": CodeBlocksPage,
	"/schema": SchemaPage,
	"/files": FilesPage,
	"/search": SearchPage,
	"/ai": AiPage,
};

export const widgets: PluginAdminExports["widgets"] = {
	"backup-status": BackupStatusWidget,
};
