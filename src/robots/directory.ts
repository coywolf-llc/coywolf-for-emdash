/** The bundled crawler directory (see ./bots.ts and README → Robots.txt Rules for how it was built). */
import data from "./data/bots.json";

import type { BotEntry } from "./bots.js";

const BASELINE = (data as { generatedAt: string; bots: BotEntry[] }).bots;

export const BASELINE_DATE = (data as { generatedAt: string }).generatedAt;

export function baselineBots(): BotEntry[] {
	return BASELINE;
}
