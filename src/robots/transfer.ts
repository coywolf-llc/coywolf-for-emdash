/**
 * Robots.txt rules export and import: the rules and settings as one JSON
 * file, to keep a copy or move them to another site. Import goes through
 * robots/save, so the server checks the file like any other change and the
 * current version stays in Version history.
 */
import { type RobotsConfig, normalizeConfig } from "./rules.js";

export const ROBOTS_EXPORT_FORMAT = "coywolf-pack/robots-rules";

export interface RobotsExport {
	format: typeof ROBOTS_EXPORT_FORMAT;
	version: 1;
	exportedAt: string;
	site?: string;
	config: RobotsConfig;
}

/** The export file's text. `automatic` isn't stored (it comes from feature switches), so it's left out. */
export function exportRobotsRules(config: RobotsConfig, siteUrl?: string, now = new Date()): string {
	const { automatic: _automatic, ...stored } = config;
	const file: RobotsExport = { format: ROBOTS_EXPORT_FORMAT, version: 1, exportedAt: now.toISOString(), ...(siteUrl ? { site: siteUrl } : {}), config: stored };
	return `${JSON.stringify(file, null, "\t")}\n`;
}

/**
 * Read an export (or a bare config object) back into a config. Notes about
 * where the original rules were imported from describe the other site, so
 * they're dropped. Throws an Error with a readable message.
 */
export function readRobotsImport(text: string): RobotsConfig {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.replace(/^﻿/, ""));
	} catch {
		throw new Error("That file isn't a Coywolf Pack robots.txt rules export (it isn't valid JSON).");
	}
	const object = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
	const raw = object && object.format === ROBOTS_EXPORT_FORMAT ? object.config : object;
	if (!raw || typeof raw !== "object" || !Array.isArray((raw as { rules?: unknown }).rules)) {
		throw new Error("That file isn't a Coywolf Pack robots.txt rules export (it has no rules).");
	}
	const { importedAt: _at, importMode: _mode, importNotes: _notes, automatic: _automatic, ...config } = raw as RobotsConfig;
	return normalizeConfig(config);
}
