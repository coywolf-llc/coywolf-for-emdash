import { PluginRouteError } from "emdash";
import type { z } from "zod";

/** Cloudflare bindings. Imported lazily: astro.config.mjs loads the plugin in Node, where cloudflare:workers doesn't exist. */
export async function workerEnv(): Promise<Record<string, unknown>> {
	const { env } = (await import("cloudflare:workers")) as unknown as { env: Record<string, unknown> };
	return env;
}

/** Run `promise` after the response (waitUntil), or just let it run outside Workers. */
export async function afterResponse(promise: Promise<unknown>): Promise<void> {
	try {
		const workers = (await import("cloudflare:workers")) as unknown as { waitUntil?: (p: Promise<unknown>) => void };
		if (workers.waitUntil) return workers.waitUntil(promise);
	} catch {
		// Not in a Worker.
	}
	void promise;
}

/** Read a Worker secret (env binding, or process.env under nodejs_compat). */
export function secret(env: Record<string, unknown>, name: string): string | undefined {
	return (env[name] as string | undefined) ?? (globalThis as { process?: { env?: Record<string, string> } }).process?.env?.[name];
}

/** Validate a route body, reporting problems to the admin instead of a generic 500. */
export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
	const result = schema.safeParse(input);
	if (!result.success) throw PluginRouteError.badRequest(result.error.issues.map((i) => i.message).join("; "));
	return result.data;
}

export interface SettingsReader {
	settings: { get<T>(key: string): Promise<T | null | undefined> };
}

export interface CronScheduler {
	cron?: { schedule(name: string, opts: { schedule: string }): Promise<void> };
}
