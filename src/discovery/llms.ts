/**
 * llms.txt (pure part), per https://llmstxt.org/ and Coywolf SEO's layout:
 * an H1 with the site name, a blockquote summary, a short detail paragraph,
 * one H2 "file list" per collection linking each entry (to its Markdown
 * source when per-page Markdown is on), and an "## Optional" section for the
 * long tail.
 */

/** Links per collection in the main lists; the rest move to "## Optional". */
export const MAIN_LIMIT = 100;
export const DEFAULT_MAX_ENTRIES = 1000;

export interface LlmsEntry {
	title: string;
	url: string;
	note?: string | null;
}

export interface LlmsSection {
	label: string;
	entries: LlmsEntry[];
}

export interface LlmsInput {
	/** Site name (falls back to the site URL). */
	name: string;
	siteUrl: string;
	/** Blockquote summary: the site tagline, or a default. */
	summary?: string | null;
	/** Detail paragraph under the summary. */
	intro?: string | null;
	/** Whether links point at Markdown sources (changes the default intro). */
	markdownLinks: boolean;
	sections: LlmsSection[];
	/** Total links across the file. Default 1,000. */
	maxEntries?: number;
}

export const DEFAULT_SUMMARY = "A curated, agent-readable index of this site's public content.";
export const DEFAULT_INTRO_MARKDOWN = "Each link below points at the Markdown source of a page, so an agent can read the content directly.";
export const DEFAULT_INTRO_HTML = "Each link below points at a page on this site.";

/** Plain text for llms.txt: one line, no Markdown link breakers. */
export function llmsText(text: string): string {
	return text.replace(/\s+/g, " ").trim().replace(/([[\]])/g, "\\$1");
}

function linkLine(entry: LlmsEntry): string {
	const url = entry.url.replace(/[()\s]/g, (c) => encodeURIComponent(c));
	const note = entry.note ? llmsText(entry.note) : "";
	return `- [${llmsText(entry.title) || url}](${url})${note ? `: ${note}` : ""}\n`;
}

export function buildLlmsTxt(input: LlmsInput): string {
	const max = Math.max(1, input.maxEntries ?? DEFAULT_MAX_ENTRIES);
	const name = llmsText(input.name) || input.siteUrl;
	const summary = input.summary?.trim() ? input.summary.replace(/\s+/g, " ").trim() : DEFAULT_SUMMARY;
	const intro = input.intro?.trim() ? input.intro.trim() : input.markdownLinks ? DEFAULT_INTRO_MARKDOWN : DEFAULT_INTRO_HTML;

	let out = `# ${name}\n\n> ${summary}\n\n${intro}\n`;
	let used = 0;
	const optional: LlmsEntry[] = [];

	for (const section of input.sections) {
		if (!section.entries.length || used >= max) continue;
		const main = section.entries.slice(0, Math.min(MAIN_LIMIT, max - used));
		used += main.length;
		out += `\n## ${llmsText(section.label)}\n\n`;
		for (const entry of main) out += linkLine(entry);
		optional.push(...section.entries.slice(main.length));
	}

	const rest = optional.slice(0, Math.max(0, max - used));
	if (rest.length) {
		out += "\n## Optional\n\n";
		for (const entry of rest) out += linkLine(entry);
	}
	return out;
}
