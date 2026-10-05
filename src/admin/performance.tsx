/**
 * Performance page (always on, right below Coywolf Pack in the sidebar): how
 * long Cloudflare's edge keeps pages (Workers Cache), the media host's Cache
 * Rule, and a button that clears every cached page plus the media host's
 * images. Cloudflare's zone "Purge Everything" doesn't reach the pages (the
 * cache belongs to the Worker, not the zone).
 */
import { Banner, Button, Input } from "@cloudflare/kumo";
import { ArrowsClockwise, Lightning } from "@phosphor-icons/react";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import * as React from "react";

import { errorText } from "./settings-ui.js";

const API = "/_emdash/api/plugins/coywolf-pack/cache";

interface Lifetimes {
	maxAgeDays: number;
	refreshDays: number;
	images: boolean;
}

interface MediaCache {
	host: string | null;
	zone?: string;
	reason?: string;
	rule: { edgeTtl?: number; browserTtl?: number; enabled: boolean } | null;
}

type Notice = { variant: "default" | "error"; text: string } | null;

async function post<T>(path: string, body?: unknown): Promise<T> {
	const response = await apiFetch(`${API}/${path}`, {
		method: "POST",
		...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
	});
	return parseApiResponse<T>(response, "Something went wrong");
}

const days = (seconds?: number) => (seconds ? Math.round(seconds / 86400) : 0);

export function PerformancePage() {
	const [lifetimes, setLifetimes] = React.useState<Lifetimes | null>(null);
	const [draft, setDraft] = React.useState({ maxAgeDays: "", refreshDays: "" });
	const [media, setMedia] = React.useState<MediaCache | null>(null);
	const [busy, setBusy] = React.useState<"save" | "media" | "clear" | null>(null);
	const [notice, setNotice] = React.useState<Notice>(null);

	const load = React.useCallback(async () => {
		try {
			const loaded = await parseApiResponse<Lifetimes>(await apiFetch(`${API}/settings`), "Couldn't load the page cache settings");
			setLifetimes(loaded);
			setDraft({ maxAgeDays: String(loaded.maxAgeDays), refreshDays: String(loaded.refreshDays) });
			if (loaded.images) setMedia(await parseApiResponse<MediaCache>(await apiFetch(`${API}/media`), "Couldn't check the media cache"));
		} catch (cause) {
			setNotice({ variant: "error", text: errorText(cause, "Couldn't load the page cache settings") });
		}
	}, []);

	React.useEffect(() => {
		void load();
	}, [load]);

	async function run(kind: "save" | "media" | "clear", action: () => Promise<string>) {
		setBusy(kind);
		setNotice(null);
		try {
			setNotice({ variant: "default", text: await action() });
		} catch (cause) {
			setNotice({ variant: "error", text: errorText(cause, "Something went wrong") });
		} finally {
			setBusy(null);
		}
	}

	const save = () =>
		run("save", async () => {
			const next = await post<{ maxAgeDays: number; refreshDays: number }>("settings/save", {
				maxAgeDays: Number(draft.maxAgeDays),
				refreshDays: Number(draft.refreshDays),
			});
			setLifetimes((l) => (l ? { ...l, ...next } : l));
			return "Saved. Cached pages were cleared, so new visits use the new lifetime.";
		});

	const applyMedia = () =>
		run("media", async () => {
			const result = await post<MediaCache>("media/apply");
			setMedia(result);
			return `${result.host} is now cached at Cloudflare's edge and in browsers for a year.`;
		});

	const clear = () =>
		run("clear", async () => {
			const result = await post<{ pages: boolean; images: { purged: boolean; host: string | null; message?: string } }>("purge");
			const done = [result.pages && "pages", result.images.purged && `images on ${result.images.host}`].filter(Boolean).join(" and ");
			const warning = !result.images.purged && result.images.host ? ` ${result.images.message ?? ""}` : "";
			if (warning) throw new Error(`Cleared ${done || "nothing"}.${warning}`);
			return `Cleared ${done}. Everything is cached again the next time someone visits it.`;
		});

	const dirty = lifetimes && (String(lifetimes.maxAgeDays) !== draft.maxAgeDays || String(lifetimes.refreshDays) !== draft.refreshDays);

	return (
		<div className="space-y-6">
			<header className="grid min-w-0 gap-4 border-b border-kumo-line pb-4">
				<h1 className="flex min-h-9 min-w-0 items-center text-2xl font-semibold leading-tight">Performance</h1>
				<p className="text-sm leading-5 text-pretty text-kumo-subtle">
					Cloudflare keeps copies of your public pages at its edge (Workers Cache), so visitors get them without waiting for the
					site to build them. EmDash clears the pages that change when you publish or edit content, menus or settings; Coywolf
					Pack clears everything after each deploy and whenever its settings change. These settings take effect on sites that
					turn on Workers Cache (Astro's cacheCloudflare(); see the Coywolf Pack README).
				</p>
			</header>

			<section className="rounded-lg border border-kumo-line" aria-label="Performance settings">
			<div className="divide-y divide-kumo-line">
				{notice && (
					<div className="p-4">
						<Banner variant={notice.variant === "error" ? "error" : "default"} title={notice.text} />
					</div>
				)}

				<div className="grid gap-4 p-4">
					<h2 className="text-base font-semibold">Page cache</h2>
					<div className="grid gap-4 sm:grid-cols-2">
						<Input
							type="number"
							min={1}
							max={365}
							label="Keep pages for (days)"
							description="After this, the edge asks the site for a fresh copy."
							value={draft.maxAgeDays}
							onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft((d) => ({ ...d, maxAgeDays: e.target.value }))}
						/>
						<Input
							type="number"
							min={0}
							max={365}
							label="Refresh in the background for (days)"
							description="While a fresh copy is made, visitors still get the cached one instantly."
							value={draft.refreshDays}
							onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft((d) => ({ ...d, refreshDays: e.target.value }))}
						/>
					</div>
					<div>
						<Button variant="primary" disabled={!dirty || busy !== null} onClick={() => void save()}>
							{busy === "save" ? "Saving…" : "Save"}
						</Button>
					</div>
				</div>

				{lifetimes?.images && media && (
					<div className="flex flex-wrap items-center justify-between gap-4 p-4">
						<div className="min-w-0 max-w-2xl">
							<h2 className="text-base font-semibold">Media cache</h2>
							<p className="text-sm leading-5 text-pretty text-kumo-subtle">
								{!media.host
									? media.reason
									: media.rule
										? `${media.host} is cached at Cloudflare's edge for ${days(media.rule.edgeTtl)} days and in browsers for ${days(media.rule.browserTtl)} days${media.rule.enabled ? "" : " (the rule is turned off)"}.`
										: media.reason
											? `Couldn't check ${media.host}: ${media.reason} The token needs Zone → Cache Rules → Edit.`
											: `${media.host} isn't cached at Cloudflare's edge yet, so every image is fetched from storage. Media file names never change, so a year is safe.`}
							</p>
						</div>
						{media.host && !(media.rule && days(media.rule.edgeTtl) >= 365 && media.rule.enabled) && (
							<Button variant="secondary" icon={<Lightning />} disabled={busy !== null || Boolean(media.reason)} onClick={() => void applyMedia()}>
								{busy === "media" ? "Setting up…" : "Cache media for a year"}
							</Button>
						)}
					</div>
				)}

				<div className="flex flex-wrap items-center justify-between gap-4 p-4">
					<div className="min-w-0 max-w-2xl">
						<h2 className="text-base font-semibold">Clear the cache</h2>
						<p className="text-sm leading-5 text-pretty text-kumo-subtle">
							Removes every cached page and the images on your media host, for example after replacing an image or changing
							theme files outside a deploy. Cloudflare's “Purge Everything” for the zone doesn't clear these pages; use this
							button instead. Clearing images uses the Cloudflare API token from Clean Image URLs (it needs Zone → Cache Purge →
							Purge).
						</p>
					</div>
					<Button variant="secondary" icon={<ArrowsClockwise />} disabled={busy !== null} onClick={() => void clear()}>
						{busy === "clear" ? "Clearing…" : "Clear pages and images"}
					</Button>
				</div>
			</div>
			</section>
		</div>
	);
}
