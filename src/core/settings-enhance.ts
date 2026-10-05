/**
 * Step-by-step guides on EmDash's generic plugin Settings page
 * (/_emdash/admin/plugins-manager/coywolf-pack/settings). EmDash renders that
 * page from the settings schema and shows each field's description as plain
 * text, so the pack middleware adds this small script to admin pages. On that
 * page it swaps each secret's plain-text description for a short line plus the
 * guides in closed <details> (the same ones the module pages show).
 *
 * Progressive enhancement: it looks the fields up by their label, and if
 * EmDash's markup ever changes it does nothing, leaving the plain-text steps
 * from secrets.ts in place.
 */
import { GUIDES, SETTINGS_PAGE_GUIDES, guideHtml } from "./guide-content.js";
import { SECRET_SETTINGS } from "./secrets.js";

const PAGE = /\/_emdash\/admin\/plugins-manager\/coywolf-pack\/settings\/?$/;

/** Label text → the HTML that replaces that field's description. */
export function settingsGuideHtml(): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, entry] of Object.entries(SETTINGS_PAGE_GUIDES)) {
		const field = (SECRET_SETTINGS as Record<string, { label: string }>)[key];
		if (!field) continue;
		const guides = entry.guides.map((id) => guideHtml(GUIDES[id])).join("");
		out[field.label] = `<p class="text-sm leading-snug text-kumo-subtle" data-cw-intro>${entry.intro}</p><div class="space-y-2">${guides}</div>`;
	}
	return out;
}

/** Built once per isolate: its content only changes with a deploy. */
let enhanceScript: string | null = null;

/**
 * The inline script. JSON is escaped so it can't close the <script> element.
 * It goes on every admin page, not just the Settings page: the admin is a
 * single-page app, so a visit that starts elsewhere reaches Settings without
 * a page load (the script checks the path itself).
 */
export function settingsEnhanceScript(): string {
	enhanceScript ??= buildEnhanceScript();
	return enhanceScript;
}

function buildEnhanceScript(): string {
	const data = JSON.stringify(settingsGuideHtml()).replace(/</g, "\\u003c").replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`);
	return `(function(){var D=${data};var P=${PAGE.toString()};var q=0;
function run(){q=0;if(!P.test(location.pathname))return;var f=document.getElementById("plugin-settings-form");if(!f)return;
f.querySelectorAll("input[aria-labelledby][aria-describedby]").forEach(function(i){if(i.getAttribute("data-cw-guide"))return;
var l=document.getElementById(i.getAttribute("aria-labelledby"));var h=l&&D[l.textContent.trim()];if(!h)return;
var d=document.getElementById(i.getAttribute("aria-describedby"));if(!d||!d.parentNode)return;
var b=document.createElement("div");b.className="col-span-full space-y-2";b.setAttribute("data-cw-guides","");b.innerHTML=h;
var p=b.querySelector("[data-cw-intro]");p.id=d.id+"-cw";d.hidden=true;d.parentNode.insertBefore(b,d.nextSibling);
i.setAttribute("aria-describedby",p.id);i.setAttribute("data-cw-guide","1");});}
function later(){if(!q)q=requestAnimationFrame(run);}
new MutationObserver(later).observe(document.documentElement,{childList:true,subtree:true});later();})();`;
}

/** Add the script to an admin HTML page. Returns the response unchanged when it isn't HTML. */
export async function injectAdminEnhancements(response: Response): Promise<Response> {
	if (!(response.headers.get("content-type") ?? "").includes("text/html") || response.status !== 200) return response;
	const html = await response.text();
	const at = html.lastIndexOf("</body>");
	const script = `<script data-coywolf-pack>${settingsEnhanceScript()}</script>`;
	const body = at === -1 ? html + script : html.slice(0, at) + script + html.slice(at);
	const headers = new Headers(response.headers);
	headers.delete("content-length");
	const out = new Response(body, { status: response.status, statusText: response.statusText, headers });
	// Astro keeps cookies set during the request on the response under this symbol; a new
	// Response drops it, which would lose session cookies (EmDash's middleware does the same).
	const cookies = Symbol.for("astro.cookies");
	const value = (response as unknown as Record<symbol, unknown>)[cookies];
	if (value !== undefined) (out as unknown as Record<symbol, unknown>)[cookies] = value;
	return out;
}
