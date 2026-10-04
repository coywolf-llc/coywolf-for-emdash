/**
 * Content Blocks page: the site's affiliate disclosure wording, and live
 * previews of the Note, Details, Affiliate disclosure and Quote blocks
 * (rendered by the same code as the site). Turning blocks on or off happens on
 * the Coywolf Pack page.
 */
import { Banner, Button, Input, InputArea, Loader } from "@cloudflare/kumo";
import { FloppyDisk } from "@phosphor-icons/react";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import * as React from "react";

import { PreviewSection } from "./preview.js";
import { SaveBar } from "./save-bar.js";
import {
	CONTENT_BLOCKS_CSS,
	DEFAULT_DISCLOSURE,
	type DisclosureSettings,
	MAX_DISCLOSURE_TEXT,
	NOTE_VARIANTS,
	SAMPLE_DETAILS,
	SAMPLE_NOTE,
	SAMPLE_QUOTE,
	normalizeDisclosureSettings,
	renderDetailsHtml,
	renderDisclosureHtml,
	renderNoteHtml,
	renderQuoteHtml,
} from "../contentBlocks/render.js";
import { safeUrl } from "../contentBlocks/rich.js";

const API = "/_emdash/api/plugins/coywolf-pack/contentBlocks";

const errorText = (cause: unknown, fallback: string) => (cause instanceof Error && cause.message ? cause.message : fallback);

const same = (a: DisclosureSettings, b: DisclosureSettings) =>
	a.affiliateText === b.affiliateText && a.amazonText === b.amazonText && a.linkUrl === b.linkUrl && a.linkText === b.linkText;

export function ContentBlocksPage() {
	const [saved, setSaved] = React.useState<DisclosureSettings | null>(null);
	const [draft, setDraft] = React.useState<DisclosureSettings>(DEFAULT_DISCLOSURE);
	const [error, setError] = React.useState<string | null>(null);
	const [status, setStatus] = React.useState("");
	const [saving, setSaving] = React.useState(false);

	React.useEffect(() => {
		void (async () => {
			try {
				const r = await apiFetch(`${API}/settings`).then((res) => parseApiResponse<{ settings: DisclosureSettings }>(res, "Couldn't load settings"));
				setDraft(r.settings);
				setSaved(r.settings);
			} catch (cause) {
				setError(errorText(cause, "Couldn't load settings"));
			}
		})();
	}, []);

	const dirty = saved !== null && !same(draft, saved);
	const linkValid = !draft.linkUrl.trim() || Boolean(safeUrl(draft.linkUrl.trim()));
	const tooLong = draft.affiliateText.length > MAX_DISCLOSURE_TEXT || draft.amazonText.length > MAX_DISCLOSURE_TEXT;
	const canSave = linkValid && !tooLong;
	const set = (patch: Partial<DisclosureSettings>) => setDraft((cur) => ({ ...cur, ...patch }));

	async function save() {
		if (!saved || !canSave) return;
		setSaving(true);
		setError(null);
		setStatus("Saving…");
		try {
			const response = await apiFetch(`${API}/settings/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(draft),
			});
			const r = await parseApiResponse<{ settings: DisclosureSettings }>(response, "Couldn't save");
			setDraft(r.settings);
			setSaved(r.settings);
			setStatus("Saved. The site picks up changes within a minute.");
		} catch (cause) {
			setStatus("");
			setError(errorText(cause, "Couldn't save"));
		} finally {
			setSaving(false);
		}
	}

	// What the site would print with the draft (empty fields fall back to the defaults, as on save).
	const effective = normalizeDisclosureSettings(draft);
	const notes = NOTE_VARIANTS.map(([variant], i) => renderNoteHtml({ ...SAMPLE_NOTE, variant, body: i ? `A ${variant === "editor" ? "note from the editor" : variant}, set apart from the text.` : SAMPLE_NOTE.body }, `cw-note-sample-${variant}`)).join("");
	const disclosures =
		renderDisclosureHtml({ kind: "affiliate", text: "" }, effective) + renderDisclosureHtml({ kind: "amazon", text: "" }, effective);
	const details = renderDetailsHtml(SAMPLE_DETAILS) + renderDetailsHtml({ variant: "transcript", summary: "", body: "<p><abbr title=\"Jon Henshaw\">JH</abbr>: Welcome to the show.</p>\n<p><abbr title=\"Guest\">G</abbr>: Thanks for having me.</p>", open: false });
	const quote = renderQuoteHtml(SAMPLE_QUOTE);
	const note = (
		<>
			The previews use this page's fonts and your computer's light or dark setting. On the site the blocks use your theme's fonts and text color.
		</>
	);

	return (
		<div className="space-y-6">
			<header className="grid min-w-0 gap-4 border-b border-kumo-line pb-4">
				<div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1">
					<h1 className="flex min-h-9 min-w-0 items-center text-2xl font-semibold leading-tight">Content Blocks</h1>
					<div className="flex shrink-0 justify-end">
						<Button variant="primary" icon={<FloppyDisk />} disabled={!dirty || saving || !canSave} onClick={() => void save()}>
							Save
						</Button>
					</div>
					<p className="col-span-2 text-sm leading-5 text-pretty text-kumo-subtle">
						Adds Note, Details, Affiliate disclosure and Quote blocks to the editor (turn each one on on the Coywolf Pack page). Their text fields take
						plain text: a blank line starts a new paragraph, <code>[link text](https://…)</code> makes a link and <code>**text**</code> is bold. Simple
						HTML (links, bold, italics, code, lists) works too. The blocks are styled with a little CSS sent only on pages that use them; no script.
					</p>
				</div>
			</header>

			{error && <Banner variant="error" role="alert" description={error} />}
			<p className="sr-only" role="status" aria-live="polite">
				{status}
			</p>
			{status && !saving && <p className="text-sm text-kumo-subtle">{status}</p>}

			{!saved && !error && (
				<div className="flex justify-center py-12">
					<Loader />
				</div>
			)}

			{saved && (
				<>
					<section aria-labelledby="cw-cb-disclosure" className="grid gap-6 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]">
						<div className="space-y-4">
							<div>
								<h2 id="cw-cb-disclosure" className="text-base font-semibold">
									Affiliate disclosure
								</h2>
								<p className="mt-1 text-sm text-kumo-subtle">
									The wording every Affiliate disclosure block shows, unless a block has its own. Put the block before the first affiliate link.
								</p>
							</div>
							<InputArea
								label="Affiliate links"
								rows={3}
								value={draft.affiliateText}
								placeholder={DEFAULT_DISCLOSURE.affiliateText}
								onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => set({ affiliateText: e.target.value })}
							/>
							<InputArea
								label="Amazon Associates"
								rows={2}
								value={draft.amazonText}
								placeholder={DEFAULT_DISCLOSURE.amazonText}
								onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => set({ amazonText: e.target.value })}
							/>
							<p className={`text-xs ${tooLong ? "text-kumo-danger" : "text-kumo-subtle"}`}>
								Up to {MAX_DISCLOSURE_TEXT.toLocaleString()} characters each. Amazon requires the words “As an Amazon Associate I earn from qualifying
								purchases.” Empty fields use the wording shown in gray.
							</p>
							<Input
								label="Disclosure page (optional)"
								value={draft.linkUrl}
								placeholder="/disclosures/"
								aria-invalid={!linkValid}
								onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ linkUrl: e.target.value })}
							/>
							{!linkValid && (
								<p className="text-sm text-kumo-danger" role="alert">
									Use a link like https://example.com/disclosures/ or /disclosures/.
								</p>
							)}
							<Input
								label="Link text"
								value={draft.linkText}
								placeholder={DEFAULT_DISCLOSURE.linkText}
								onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ linkText: e.target.value })}
							/>
						</div>
						<PreviewSection id="cw-cb-disclosure-preview" title="Affiliate disclosure preview" css={CONTENT_BLOCKS_CSS} html={disclosures} note={note} />
					</section>

					<section aria-labelledby="cw-cb-blocks" className="space-y-6 border-t border-kumo-line pt-6">
						<div>
							<h2 id="cw-cb-blocks" className="text-base font-semibold">
								The other blocks
							</h2>
							<p className="mt-1 text-sm text-kumo-subtle">
								They have no site settings. To restyle them, set the <code>--cw-note-accent</code> custom property or target the{" "}
								<code>.cw-note</code>, <code>.cw-details</code> and <code>.cw-quote</code> classes in your theme's CSS.
							</p>
						</div>
						<div className="grid gap-6 lg:grid-cols-2">
							<PreviewSection id="cw-cb-note-preview" title="Note block preview" css={CONTENT_BLOCKS_CSS} html={notes} />
							<div className="space-y-6">
								<PreviewSection id="cw-cb-details-preview" title="Details block preview" css={CONTENT_BLOCKS_CSS} html={details} />
								<PreviewSection id="cw-cb-quote-preview" title="Quote block preview" css={CONTENT_BLOCKS_CSS} html={quote} note={note} />
							</div>
						</div>
					</section>
				</>
			)}

			<SaveBar dirty={dirty} saving={saving} canSave={canSave} onSave={() => void save()} onDiscard={() => saved && setDraft(saved)} />
		</div>
	);
}
