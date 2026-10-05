/**
 * Page cache action for the Actions section of the Coywolf Pack page: a button
 * that clears every page Cloudflare's Workers Cache holds for this site, plus
 * the media host's images in the zone cache. Cloudflare's zone "Purge
 * Everything" doesn't reach the pages (the cache belongs to the Worker, not the
 * zone).
 */
import { Banner, Button } from "@cloudflare/kumo";
import { ArrowsClockwise } from "@phosphor-icons/react";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import * as React from "react";

import { errorText } from "./settings-ui.js";

const API = "/_emdash/api/plugins/coywolf-pack/cache";

export function PageCacheAction() {
	const [pending, setPending] = React.useState(false);
	const [notice, setNotice] = React.useState<{ variant: "default" | "error"; text: string } | null>(null);

	async function clear() {
		setPending(true);
		setNotice(null);
		try {
			const result = await parseApiResponse<{ pages: boolean; images: { purged: boolean; host: string | null; message?: string } }>(
				await apiFetch(`${API}/purge`, { method: "POST" }),
				"Couldn't clear the page cache",
			);
			const done = [result.pages && "pages", result.images.purged && `images on ${result.images.host}`].filter(Boolean).join(" and ");
			const warning = !result.images.purged && result.images.host ? ` ${result.images.message ?? ""}` : "";
			setNotice({
				variant: warning ? "error" : "default",
				text: `Cleared ${done}. Everything is cached again the next time someone visits it.${warning}`,
			});
		} catch (cause) {
			setNotice({ variant: "error", text: errorText(cause, "Couldn't clear the page cache") });
		} finally {
			setPending(false);
		}
	}

	return (
		<div className="space-y-3">
			{notice && <Banner variant={notice.variant === "error" ? "error" : "default"} title={notice.text} />}
			<div className="flex flex-wrap items-center justify-between gap-4">
				<div className="min-w-0 max-w-2xl">
					<h3 className="text-sm font-semibold">Clear the cache</h3>
					<p className="text-sm leading-5 text-pretty text-kumo-subtle">
						Removes every cached page and the images on your media host, for example after replacing an image or changing
						theme files outside a deploy. Cloudflare's “Purge Everything” for the zone doesn't clear these pages; use this
						button instead. Pages already clear themselves when you publish, after each deploy, and when Coywolf Pack settings
						change. Clearing images uses the Cloudflare API token from Clean Image URLs (it needs Zone → Cache Purge → Purge).
					</p>
				</div>
				<Button variant="secondary" icon={<ArrowsClockwise />} disabled={pending} onClick={() => void clear()}>
					{pending ? "Clearing…" : "Clear pages and images"}
				</Button>
			</div>
		</div>
	);
}
