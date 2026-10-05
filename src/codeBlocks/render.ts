/**
 * Server-side code block rendering: lowlight (highlight.js grammars, no
 * Shiki) produces a hast tree, which is turned into HTML here by hand so the
 * output is limited to escaped text and <span class="hljs-…"> elements.
 *
 * Kept free of relative imports so `node --test` can load it directly.
 */
import type { Element, Root, RootContent } from "hast";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import { common, createLowlight } from "lowlight";

// ── Languages ────────────────────────────────────────────────────

/** EmDash's editor language list (ids + labels), plus the grammar each one maps to when its id isn't one. */
const LANGUAGES: Record<string, { label: string; grammar?: string | null; aliases?: string[] }> = {
	plaintext: { label: "Plain text", aliases: ["text", "plain", "txt"] },
	astro: { label: "Astro", grammar: "xml" },
	bash: { label: "Bash", aliases: ["sh", "shell", "zsh"] },
	c: { label: "C" },
	cpp: { label: "C++", aliases: ["c++"] },
	csharp: { label: "C#", aliases: ["cs", "c#"] },
	css: { label: "CSS" },
	diff: { label: "Diff", aliases: ["patch"] },
	dockerfile: { label: "Dockerfile", aliases: ["docker"] },
	go: { label: "Go", aliases: ["golang"] },
	graphql: { label: "GraphQL", aliases: ["gql"] },
	// "markup" is Prism's name for HTML (Code Block Enhancer for WordPress stored it).
	html: { label: "HTML", grammar: "xml", aliases: ["markup"] },
	java: { label: "Java" },
	javascript: { label: "JavaScript", aliases: ["js"] },
	json: { label: "JSON" },
	jsx: { label: "JSX", grammar: "javascript" },
	kotlin: { label: "Kotlin", aliases: ["kt"] },
	lua: { label: "Lua" },
	markdown: { label: "Markdown", aliases: ["md"] },
	mdx: { label: "MDX", grammar: "markdown" },
	php: { label: "PHP" },
	python: { label: "Python", aliases: ["py"] },
	ruby: { label: "Ruby", aliases: ["rb"] },
	rust: { label: "Rust", aliases: ["rs"] },
	scss: { label: "SCSS", aliases: ["sass"] },
	sql: { label: "SQL" },
	svelte: { label: "Svelte", grammar: "xml" },
	swift: { label: "Swift" },
	toml: { label: "TOML", grammar: "ini" },
	tsx: { label: "TSX", grammar: "typescript" },
	typescript: { label: "TypeScript", aliases: ["ts"] },
	vue: { label: "Vue", grammar: "xml" },
	xml: { label: "XML", aliases: ["svg", "mathml"] },
	yaml: { label: "YAML", aliases: ["yml"] },
	zig: { label: "Zig", grammar: null },
	// Common highlight.js grammars the editor doesn't list but content may use.
	ini: { label: "INI" },
	less: { label: "Less" },
	makefile: { label: "Makefile" },
	objectivec: { label: "Objective-C" },
	perl: { label: "Perl" },
	r: { label: "R" },
	shell: { label: "Shell session" },
	wasm: { label: "WebAssembly" },
};

const ALIASES = new Map<string, string>();
for (const [id, lang] of Object.entries(LANGUAGES)) {
	ALIASES.set(id, id);
	for (const alias of lang.aliases ?? []) ALIASES.set(alias, id);
}

let lowlight: ReturnType<typeof createLowlight> | null = null;
function engine() {
	if (!lowlight) {
		lowlight = createLowlight(common);
		lowlight.register({ dockerfile });
	}
	return lowlight;
}

export interface ResolvedLanguage {
	/** Sanitized id for the `language-…` class (EmDash's convention), or null. */
	id: string | null;
	/** Display label, or null for none / plain text. */
	label: string | null;
	/** lowlight grammar to use, or null for plain text. */
	grammar: string | null;
}

export function resolveLanguage(raw: string | null | undefined): ResolvedLanguage {
	const needle = typeof raw === "string" ? raw.trim().toLowerCase() : "";
	if (!needle) return { id: null, label: null, grammar: null };
	const known = ALIASES.get(needle);
	if (known) {
		const lang = LANGUAGES[known]!;
		const grammar = known === "plaintext" ? null : lang.grammar === undefined ? known : lang.grammar;
		return {
			id: known,
			label: known === "plaintext" ? null : lang.label,
			grammar: grammar && engine().registered(grammar) ? grammar : null,
		};
	}
	const id = needle.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || null;
	// Unknown to the editor but maybe a highlight.js alias (e.g. "ps1"); otherwise plain text.
	const grammar = id && engine().registered(id) ? id : null;
	return { id, label: id ? (raw as string).trim().slice(0, 40) : null, grammar };
}

// ── hast → HTML ──────────────────────────────────────────────────

/**
 * Skip highlighting for large blocks and long lines: highlight.js grammars
 * (JS/TS/CSS especially) are superlinear on long lines, which would burn
 * Workers CPU time (a 40k-character line takes seconds).
 */
export const MAX_HIGHLIGHT_CHARS = 30_000;
export const MAX_HIGHLIGHT_LINE = 2_000;

function tooCostly(code: string): boolean {
	if (code.length > MAX_HIGHLIGHT_CHARS) return true;
	let start = 0;
	while (start <= code.length) {
		const end = code.indexOf("\n", start);
		const stop = end === -1 ? code.length : end;
		if (stop - start > MAX_HIGHLIGHT_LINE) return true;
		if (end === -1) break;
		start = end + 1;
	}
	return false;
}

const CLASS_OK = /^(?:hljs-[a-z0-9_-]+|[a-z][a-z0-9]*_+)$/i;

export function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

interface Segment {
	/** One entry per open span, each a space-joined class list. */
	stack: string[];
	text: string;
}

function classesOf(node: Element): string {
	const raw: unknown = node.properties?.className;
	const list: unknown[] = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/\s+/) : [];
	return list.map(String).filter((c) => CLASS_OK.test(c)).join(" ");
}

function flatten(nodes: RootContent[], stack: string[], out: Segment[]): void {
	for (const node of nodes) {
		if (node.type === "text") {
			if (node.value) out.push({ stack, text: node.value });
		} else if (node.type === "element") {
			const cls = classesOf(node);
			flatten(node.children as RootContent[], cls ? [...stack, cls] : stack, out);
		}
		// Comments, doctypes, raw: never emitted.
	}
}

/** Split segments into lines; a span crossing a newline is closed and reopened on the next line. */
function toLines(segments: Segment[]): Segment[][] {
	const lines: Segment[][] = [[]];
	for (const seg of segments) {
		const parts = seg.text.split("\n");
		parts.forEach((part, i) => {
			if (i > 0) lines.push([]);
			if (part) lines[lines.length - 1]!.push({ stack: seg.stack, text: part });
		});
	}
	return lines;
}

function renderLine(line: Segment[]): string {
	let html = "";
	let open: string[] = [];
	for (const seg of line) {
		let common = 0;
		while (common < open.length && common < seg.stack.length && open[common] === seg.stack[common]) common++;
		html += "</span>".repeat(open.length - common);
		for (const cls of seg.stack.slice(common)) html += `<span class="${escapeHtml(cls)}">`;
		open = seg.stack;
		html += escapeHtml(seg.text);
	}
	return html + "</span>".repeat(open.length);
}

/** Render a lowlight tree to HTML lines (no trailing empty line). */
export function hastToLines(tree: Root): string[] {
	const segments: Segment[] = [];
	flatten(tree.children, [], segments);
	const lines = toLines(segments).map(renderLine);
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

export function highlightLines(code: string, grammar: string | null): string[] {
	const tree: Root =
		grammar && !tooCostly(code)
			? engine().highlight(grammar, code)
			: { type: "root", children: [{ type: "text", value: code }] };
	return hastToLines(tree);
}

// ── Block markup ─────────────────────────────────────────────────

export interface BlockOptions {
	label: boolean;
	copy: boolean;
	lineNumbers: boolean;
}

export interface CodeNode {
	code: string;
	language?: string;
	filename?: string;
}

const COPY_ICON =
	'<svg class="cw-code-i-copy" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const CHECK_ICON =
	'<svg class="cw-code-i-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><polyline points="20 6 9 17 4 12"/></svg>';

/** Rendered blocks, per isolate, so page views don't re-highlight. */
const CACHE_MAX = 200;
const cache = new Map<string, string>();

/** cyrb53: fast 53-bit string hash. */
function hash(text: string): string {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < text.length; i++) {
		const ch = text.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export function renderBlock(node: CodeNode, options: BlockOptions): string {
	const code = String(node.code ?? "");
	const key = [
		Number(options.label),
		Number(options.copy),
		Number(options.lineNumbers),
		typeof node.language === "string" ? node.language : "",
		code.length,
		hash(code),
	].join("\u0000");
	const hit = cache.get(key);
	if (hit !== undefined) {
		cache.delete(key);
		cache.set(key, hit);
		return hit;
	}
	const html = renderUncached({ ...node, code }, options);
	cache.set(key, html);
	if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
	return html;
}

function renderUncached(node: CodeNode, options: BlockOptions): string {
	const lang = resolveLanguage(node.language);
	const lines = highlightLines(node.code, lang.grammar);
	const body = options.lineNumbers ? lines.map((l) => `<span class="cw-line">${l}</span>`).join("\n") : lines.join("\n");
	const langClass = lang.id ? `language-${lang.id}` : "";
	const label = options.label && lang.label ? `<span class="cw-code-label">${escapeHtml(lang.label)}</span>` : "";
	// The header shows the language (no file name), left-aligned, with the copy button on the right.
	const head = label ? `<div class="cw-code-head">${label}</div>` : "";
	const classes = ["cw-code", head ? "" : "cw-code--bare", options.copy ? "cw-code--copy" : "", options.lineNumbers ? "cw-code--lines" : ""]
		.filter(Boolean)
		.join(" ");
	const copy = options.copy
		? `<button type="button" class="cw-code-copy" aria-label="Copy code to clipboard">${COPY_ICON}${CHECK_ICON}</button><span class="cw-code-status" role="status" aria-live="polite"></span>`
		: "";
	const pre = `<pre${langClass ? ` class="${langClass}"` : ""} tabindex="0"><code class="${langClass ? `${langClass} ` : ""}hljs">${body}</code></pre>`;
	return `<div class="${classes}"${lang.id ? ` data-language="${escapeHtml(lang.id)}"` : ""}>${head}${pre}${copy}</div>`;
}

// ── Chrome CSS + copy script (sent once per page) ────────────────

export const CHROME_CSS = [
	".cw-code{position:relative;margin:1.5rem 0;border-radius:.5rem;overflow:hidden;font-size:.875rem;line-height:1.6;box-shadow:inset 0 0 0 1px color-mix(in srgb,currentColor 12%,transparent)}",
	".cw-code-head{display:flex;align-items:center;gap:.75rem;min-height:2.75rem;padding:.25rem 1rem;font:.75rem/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.02em;border-bottom:1px solid color-mix(in srgb,currentColor 15%,transparent)}",
	".cw-code--copy .cw-code-head{padding-right:3.25rem}",
	".cw-code-label{font-weight:600;color:var(--cw-label,currentColor)}",
	".cw-code pre{margin:0;padding:1rem;overflow-x:auto;background:transparent;color:inherit;border:0;border-radius:0;tab-size:4}",
	".cw-code--bare.cw-code--copy pre{padding-right:3.25rem}",
	".cw-code pre:focus-visible{outline:2px solid currentColor;outline-offset:-2px}",
	".cw-code code{display:block;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace;font-size:inherit;background:none;padding:0;color:inherit;white-space:pre}",
	".cw-code--lines code{counter-reset:cw-line}",
	".cw-code--lines .cw-line::before{counter-increment:cw-line;content:counter(cw-line);display:inline-block;width:2.5ch;margin-right:1.25ch;text-align:right;color:var(--cw-line,currentColor);user-select:none}",
	".cw-code-copy{position:absolute;top:.375rem;right:.375rem;display:inline-flex;align-items:center;justify-content:center;width:2rem;height:2rem;padding:0;color:inherit;background:transparent;border:1px solid color-mix(in srgb,currentColor 25%,transparent);border-radius:.5rem;cursor:pointer;opacity:.75;transition:opacity .15s ease,background-color .15s ease}",
	".cw-code-copy:hover{opacity:1;background:color-mix(in srgb,currentColor 10%,transparent)}",
	".cw-code-copy:focus-visible{opacity:1;outline:2px solid currentColor;outline-offset:2px}",
	".cw-code-copy svg{width:1rem;height:1rem}",
	".cw-code-i-check,.cw-code-copy.is-done .cw-code-i-copy{display:none}.cw-code-copy.is-done .cw-code-i-check{display:block}",
	".cw-code-status{position:absolute;top:.625rem;right:2.875rem;padding:.2rem .5rem;font-size:.75rem;line-height:1.4;white-space:nowrap;color:#fff;background:#111;border-radius:.375rem;opacity:0;pointer-events:none;transition:opacity .15s ease}",
	".cw-code-status.is-visible{opacity:1}",
	"@media (prefers-reduced-motion:reduce){.cw-code-copy,.cw-code-status{transition:none}}",
].join("");

/** Event-delegated copy handler; installs once per page. Mirrors Code Block Enhancer's pattern. */
export const COPY_SCRIPT = `(()=>{if(window.__cwCodeCopy)return;window.__cwCodeCopy=1;function w(t){if(navigator.clipboard&&window.isSecureContext)return navigator.clipboard.writeText(t);return new Promise(function(y,n){var a=document.createElement("textarea");a.value=t;a.setAttribute("readonly","");a.style.cssText="position:fixed;top:0;opacity:0";document.body.appendChild(a);a.select();try{document.execCommand("copy")?y():n()}catch(e){n(e)}finally{a.remove()}})}document.addEventListener("click",function(e){var b=e.target instanceof Element&&e.target.closest(".cw-code-copy");if(!b)return;var r=b.closest(".cw-code"),c=r&&r.querySelector("code"),s=r&&r.querySelector(".cw-code-status");if(!c||!s)return;function f(ok){b.classList.toggle("is-done",ok);s.textContent=ok?"Copied to clipboard":"Copy failed";s.classList.add("is-visible");clearTimeout(b._cwT);b._cwT=setTimeout(function(){b.classList.remove("is-done");s.classList.remove("is-visible");s.textContent=""},2000)}w(c.textContent||"").then(function(){f(true)},function(){f(false)})})})();`;
