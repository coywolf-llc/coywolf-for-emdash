/**
 * The plugin's EmDash `admin.settingsSchema`: API keys and tokens only.
 *
 * EmDash renders this schema as the plugin's generic Settings page and uses
 * the same schema to decide which settings are encrypted: a key declared
 * `type: "secret"` is encrypted on write and decrypted on read, and reading
 * an encrypted value whose key isn't declared secret throws. So every secret
 * stays declared here permanently, whatever the feature switches or module
 * options say, and the keys never change (stored values must keep working).
 *
 * Every other setting is plain JSON, edited on its module's own admin page
 * (ctx.settings.get/set work for keys that aren't in the schema).
 *
 * Kept free of imports so tests can load it directly.
 */

export interface SecretSettingField {
	type: "secret";
	label: string;
	description?: string;
}

export const SECRET_SETTINGS = {
	aiApiKey: {
		type: "secret",
		label: "AI Enrichment — API key",
		description:
			"For Anthropic, OpenAI or Gemini (Workers AI needs no key). You can also enter it on the AI Enrichment page, which has the provider, models and the other AI settings.",
	},
	filesR2SecretAccessKey: {
		type: "secret",
		label: "File Downloads — R2 secret access key",
		description:
			"For large uploads. You can also enter it on the Files page → Settings, with the R2 account ID, access key ID and bucket.",
	},
	videosApiToken: {
		type: "secret",
		label: "Videos — Cloudflare Stream API token",
		description:
			"An API token with Account → Stream → Edit (or set the CF_STREAM_TOKEN Worker secret). You can also enter it on the Videos page → Settings, with the account ID and player settings.",
	},
	videosWebhookSecret: {
		type: "secret",
		label: "Videos — Stream webhook signing secret",
		description: "Filled in by Subscribe Stream webhook on the Videos page. Leave as is.",
	},
	robotsRadarToken: {
		type: "secret",
		label: "Robots.txt Rules — Cloudflare Radar API token",
		description:
			"Optional. Keeps the crawler list current from Cloudflare Radar each week (Account → Radar → Read, or the RADAR_API_TOKEN Worker secret). You can also enter it on the Robots.txt page.",
	},
} as const satisfies Record<string, SecretSettingField>;

export type SecretSettingKey = keyof typeof SECRET_SETTINGS;

/**
 * The schema EmDash sees: the pack's secrets plus any secret fields a module
 * declares. Non-secret fields are dropped, so they never appear on the
 * generic Settings page.
 */
// biome-ignore lint/suspicious/noExplicitAny: SettingField shape is EmDash's.
export function secretSettingsSchema(moduleSchemas: Array<Record<string, any> | undefined> = []): Record<string, SecretSettingField> {
	const out: Record<string, SecretSettingField> = { ...SECRET_SETTINGS };
	for (const schema of moduleSchemas) {
		for (const [key, field] of Object.entries(schema ?? {})) {
			if (field && field.type === "secret" && !(key in out)) out[key] = field as SecretSettingField;
		}
	}
	return out;
}
