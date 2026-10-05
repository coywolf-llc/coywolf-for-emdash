/**
 * The bundled crawler directory (see ./bots.ts and README → Robots.txt Rules
 * for how it was built). About 270 KB of JSON, so it's loaded on first use by
 * the admin routes and the Radar sync, never by the robots.txt middleware or
 * page requests.
 */
import type { BotEntry } from "./bots.js";

type Directory = { generatedAt: string; bots: BotEntry[] };

let loading: Promise<Directory> | null = null;

function directory(): Promise<Directory> {
	loading ??= import("./data/bots.json", { with: { type: "json" } }).then((m) => m.default as Directory);
	return loading;
}

/** The bundled directory's crawlers. */
export async function baselineBots(): Promise<BotEntry[]> {
	return (await directory()).bots;
}

/** When the bundled directory was built. */
export async function baselineDate(): Promise<string> {
	return (await directory()).generatedAt;
}
