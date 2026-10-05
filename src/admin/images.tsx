/**
 * Clean Image URLs page: the media host (status, a live check, the setting),
 * a step-by-step guide for setting it up by hand on Cloudflare, and Set up
 * media host, which does the same through the Cloudflare API (review, then
 * apply). The feature itself is turned on or off on the Coywolf Pack page.
 */
import { Banner, Button, Input, Loader } from "@cloudflare/kumo";
import { CheckCircle, Info, MagnifyingGlass, Wrench, XCircle } from "@phosphor-icons/react";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import * as React from "react";

import { CredentialGuide } from "./guides.js";
import { SaveBar, isDirty } from "./save-bar.js";
import { SecretField, SettingsSection, errorText } from "./settings-ui.js";

const API = "/_emdash/api/plugins/coywolf-pack/images";

interface Settings {
	host: string;
	optionHost: string;
	activeHost: string;
	accountId: string;
	bucket: string;
	tokenSet: boolean;
	envToken: boolean;
	envAccountId: boolean;
	siteHost: string;
	quotaNote: string;
}

interface CheckItem {
	id: string;
	ok: boolean;
	label: string;
	detail: string;
}

interface CheckResult {
	host: string;
	file: string;
	ok: boolean;
	items: CheckItem[];
	quotaNote: string;
}

interface Plan {
	zone: string;
	plan: { host: string; done: boolean; steps: Array<{ id: string; action: string; label: string }> };
}

interface Applied {
	zone: string;
	results: Array<{ id: string; ok: boolean; message: string }>;
	check: CheckResult | null;
}

interface Draft {
	host: string;
	accountId: string;
	bucket: string;
	token: string;
}

const toDraft = (s: Settings): Draft => ({ host: s.host, accountId: s.accountId, bucket: s.bucket, token: "" });

async function post<T>(path: string, body: unknown, fallback: string): Promise<T> {
	const response = await apiFetch(`${API}/${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return parseApiResponse<T>(response, fallback);
}

function StatusIcon({ ok }: { ok: boolean }) {
	return ok ? (
		<CheckCircle size={18} weight="fill" style={{ color: "var(--color-kumo-success, #16a34a)", flexShrink: 0 }} aria-label="Passed" />
	) : (
		<XCircle size={18} weight="fill" style={{ color: "var(--color-kumo-danger, #dc2626)", flexShrink: 0 }} aria-label="Failed" />
	);
}

/** Load an image in this browser; its natural size, or null when it fails. */
function loadImage(url: string): Promise<{ width: number; height: number } | null> {
	return new Promise((resolve) => {
		const img = new Image();
		const timer = window.setTimeout(() => resolve(null), 20_000);
		img.onload = () => {
			window.clearTimeout(timer);
			resolve({ width: img.naturalWidth, height: img.naturalHeight });
		};
		img.onerror = () => {
			window.clearTimeout(timer);
			resolve(null);
		};
		img.src = url;
	});
}

/** Replace the server's fetch results with what this browser actually gets from the media host. */
async function browserCheck(result: CheckResult): Promise<CheckResult> {
	if (!result.file) return result;
	const stamp = Date.now().toString(36);
	const host = result.host.replace(/\/+$/, "");
	const [original, resized] = await Promise.all([loadImage(`${host}/${result.file}?check=${stamp}`), loadImage(`${host}/s/64x64/${result.file}`)]);
	const items: CheckItem[] = [
		{ id: "reachable", ok: Boolean(original || resized), label: "Host reachable", detail: original || resized ? "Your browser loaded images from the media host." : "Your browser couldn't load anything from the media host. Check the R2 custom domain and its DNS record." },
		{ id: "original", ok: Boolean(original), label: "Original served", detail: original ? `${result.file} (${original.width}×${original.height}).` : `${result.file} didn't load. Is the custom domain connected to the media bucket?` },
		{
			id: "resize",
			ok: Boolean(resized && resized.width === 64 && resized.height === 64),
			label: "Resize works",
			detail: !resized
				? "/s/64x64/ didn't load: the URL rewrite rules are missing, or Image Transformations are off for the zone."
				: resized.width === 64 && resized.height === 64
					? "/s/64x64/ came back at 64×64."
					: `/s/64x64/ came back at ${resized.width}×${resized.height}: the rewrite rules don't match this host.`,
		},
	];
	return { ...result, items, ok: items.every((i) => i.ok) };
}

function CheckList({ result }: { result: CheckResult }) {
	return (
		<div className="space-y-2" aria-live="polite">
			<p className="text-sm">
				Checked <span className="font-medium">{result.host}</span> with <code className="rounded bg-kumo-tint px-1 text-xs">{result.file}</code>:{" "}
				{result.ok ? "it works." : "something needs attention."}
			</p>
			<ul className="space-y-1.5">
				{result.items.map((item) => (
					<li key={item.id} className="flex items-start gap-2 text-sm">
						{item.id === "cached" && !item.ok ? (
							<Info size={18} style={{ flexShrink: 0 }} className="text-kumo-subtle" aria-label="Not yet" />
						) : (
							<StatusIcon ok={item.ok} />
						)}
						<span>
							<span className="font-medium">{item.label}.</span> <span className="text-kumo-subtle">{item.detail}</span>
						</span>
					</li>
				))}
			</ul>
		</div>
	);
}

export function ImagesPage() {
	const [saved, setSaved] = React.useState<Settings | null>(null);
	const [draft, setDraft] = React.useState<Draft>({ host: "", accountId: "", bucket: "", token: "" });
	const [error, setError] = React.useState<string | null>(null);
	const [notice, setNotice] = React.useState("");
	const [pending, setPending] = React.useState<"save" | "clear" | "check" | "plan" | "apply" | undefined>();
	const [check, setCheck] = React.useState<CheckResult | null>(null);
	const [plan, setPlan] = React.useState<Plan | null>(null);
	const [applied, setApplied] = React.useState<Applied | null>(null);

	const apply = (s: Settings) => {
		setSaved(s);
		setDraft(toDraft(s));
	};

	React.useEffect(() => {
		void (async () => {
			try {
				apply(await parseApiResponse<Settings>(await apiFetch(`${API}/settings`), "Couldn't load the settings"));
			} catch (cause) {
				setError(errorText(cause, "Couldn't load the settings"));
			}
		})();
	}, []);

	const set = (patch: Partial<Draft>) => {
		setDraft((d) => ({ ...d, ...patch }));
		// A changed host, account or bucket makes the reviewed plan stale.
		if ("host" in patch || "accountId" in patch || "bucket" in patch) setPlan(null);
	};

	const save = async (clearToken = false) => {
		setPending(clearToken ? "clear" : "save");
		setError(null);
		setNotice("");
		try {
			const { token, ...rest } = draft;
			apply(await post<Settings>("settings/save", { ...rest, ...(clearToken ? { clearToken: true } : token.trim() ? { token: token.trim() } : {}) }, "Couldn't save"));
			setNotice(clearToken ? "API token removed." : "Saved. The site picks up a new media host within a minute.");
		} catch (cause) {
			setError(errorText(cause, "Couldn't save"));
		} finally {
			setPending(undefined);
		}
	};

	const hostToUse = draft.host.trim() || saved?.activeHost || "";
	const suggestedHost = saved?.siteHost ? `media.${saved.siteHost}` : "media.example.com";
	const setupHost = draft.host.trim() || saved?.activeHost || suggestedHost;

	const runCheck = async () => {
		setPending("check");
		setError(null);
		setCheck(null);
		try {
			// The server picks a recent image from the media library. The loading itself is checked here, in the
			// browser: requests from the site's own Worker to the media host skip the zone's rewrite rules and can
			// be challenged by Bot Fight Mode, so only a visitor's view is meaningful.
			const result = await post<CheckResult>("check", { host: hostToUse }, "Couldn't check the media host");
			setCheck(await browserCheck(result));
		} catch (cause) {
			setError(errorText(cause, "Couldn't check the media host"));
		} finally {
			setPending(undefined);
		}
	};

	const setupBody = () => ({
		host: setupHost,
		...(draft.accountId.trim() ? { accountId: draft.accountId.trim() } : {}),
		...(draft.bucket.trim() ? { bucket: draft.bucket.trim() } : {}),
		...(draft.token.trim() ? { token: draft.token.trim() } : {}),
	});

	const review = async () => {
		setPending("plan");
		setError(null);
		setPlan(null);
		setApplied(null);
		try {
			setPlan(await post<Plan>("setup/plan", setupBody(), "Couldn't read the Cloudflare setup"));
		} catch (cause) {
			setError(errorText(cause, "Couldn't read the Cloudflare setup"));
		} finally {
			setPending(undefined);
		}
	};

	const applySetup = async () => {
		setPending("apply");
		setError(null);
		try {
			const result = await post<Applied>("setup/apply", setupBody(), "Couldn't set up the media host");
			setApplied(result);
			setPlan(null);
			if (result.check) setCheck(result.check);
			// Fill in the host so saving starts using it.
			if (result.results.every((r) => r.ok) && !draft.host.trim() && !saved?.activeHost) set({ host: `https://${setupHost.replace(/^https?:\/\//, "")}` });
		} catch (cause) {
			setError(errorText(cause, "Couldn't set up the media host"));
		} finally {
			setPending(undefined);
		}
	};

	const dirty = saved ? isDirty(draft, toDraft(saved)) : false;
	const busy = Boolean(pending);
	const changes = plan?.plan.steps.filter((s) => s.action !== "none").length ?? 0;

	return (
		<div className="space-y-6">
			<header className="grid min-w-0 gap-4 border-b border-kumo-line pb-4">
				<div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1">
					<h1 className="flex min-h-9 min-w-0 items-center text-2xl font-semibold leading-tight">Clean Image URLs</h1>
					<div />
					<p className="col-span-2 text-sm leading-5 text-pretty text-kumo-subtle">
						Resized images at short, cacheable addresses. With a media host, images are served and resized by Cloudflare at
						addresses like media.example.com/s/600x315/&lt;file&gt; and never touch the site's Worker. Without one, they're
						served at /media/&lt;id&gt;-600x315.webp.
					</p>
				</div>
			</header>

			{error && <Banner variant="error" role="alert" description={error} />}
			<p className="sr-only" role="status" aria-live="polite">
				{notice}
			</p>
			{notice && !busy && <p className="text-sm text-kumo-subtle">{notice}</p>}

			{!saved && !error && (
				<div className="flex justify-center py-12">
					<Loader />
				</div>
			)}

			{saved && (
				<form
					id="cw-images-form"
					className="space-y-6"
					onSubmit={(e) => {
						e.preventDefault();
						void save();
					}}
				>
					<SettingsSection
						id="images-status"
						title="Media host"
						description={
							saved.activeHost ? (
								<>
									Images use <span className="font-medium">{saved.activeHost}</span>
									{saved.host ? " (saved here)" : " (from astro.config.mjs)"}. Old /media/ addresses redirect there.
								</>
							) : (
								"None yet: images use the site's /media/ addresses, resized by the Worker."
							)
						}
						actions={
							<Button type="button" variant="secondary" icon={<MagnifyingGlass />} disabled={busy || !hostToUse} onClick={() => void runCheck()}>
								{pending === "check" ? "Checking…" : "Check"}
							</Button>
						}
					>
						<Input
							label="Media host"
							placeholder={`https://${suggestedHost}`}
							description={
								saved.optionHost
									? `Leave empty to use the one in astro.config.mjs (${saved.optionHost}). Check it before saving: images switch to it right away.`
									: "An https address like https://media.example.com. Check it before saving: images switch to it right away."
							}
							value={draft.host}
							disabled={busy}
							onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ host: e.target.value })}
						/>
						{check && <CheckList result={check} />}
						<p className="text-xs text-kumo-subtle">{saved.quotaNote}</p>
						<CredentialGuide id="media-host" />
					</SettingsSection>

					<SettingsSection
						id="images-setup"
						title="Set up media host"
						description={
							<>
								Optional: does the Cloudflare setup for you, for <span className="font-medium">{setupHost.replace(/^https?:\/\//, "")}</span>. It turns
								on Image Transformations for the zone, connects the host to the media bucket, and adds the two URL rewrite rules,
								skipping anything already done. You'll see the plan before anything changes.
							</>
						}
						actions={
							<Button type="button" variant="secondary" icon={<Wrench />} disabled={busy} onClick={() => void review()}>
								{pending === "plan" ? "Reading…" : "Review setup"}
							</Button>
						}
					>
						<div className="grid gap-4 sm:grid-cols-2">
							<Input
								label="Cloudflare account ID"
								description={saved.envAccountId ? "CF_ACCOUNT_ID is set; it's used when this is empty." : undefined}
								value={draft.accountId}
								disabled={busy}
								onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ accountId: e.target.value })}
							/>
							<Input
								label="R2 bucket name"
								description="The bucket bound as MEDIA in wrangler.jsonc (its bucket_name)."
								value={draft.bucket}
								disabled={busy}
								onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ bucket: e.target.value })}
							/>
							<SecretField
								label="Cloudflare API token"
								saved={saved.tokenSet}
								value={draft.token}
								onChange={(value) => set({ token: value })}
								description={
									saved.envToken
										? "A Worker secret (IMAGES_API_TOKEN or CLOUDFLARE_API_TOKEN) is set; it's used when no token is saved here."
										: "Used only for this setup. Saving it is optional (stored encrypted)."
								}
								onClear={() => void save(true)}
								clearing={pending === "clear"}
								disabled={busy}
							/>
						</div>
						<CredentialGuide id="images-token" />

						{plan && (
							<div className="space-y-3 rounded-md border border-kumo-line p-3" aria-live="polite">
								<p className="text-sm font-medium">
									{plan.plan.done ? `Everything is already set up on ${plan.zone}.` : `Plan for ${plan.zone} (${changes} change${changes === 1 ? "" : "s"}):`}
								</p>
								<ul className="space-y-1.5">
									{plan.plan.steps.map((step) => (
										<li key={step.id} className="flex items-start gap-2 text-sm">
											{step.action === "none" ? <StatusIcon ok /> : <Wrench size={18} style={{ flexShrink: 0 }} aria-label="Will change" />}
											<span className={step.action === "none" ? "text-kumo-subtle" : undefined}>{step.label}</span>
										</li>
									))}
								</ul>
								{!plan.plan.done && (
									<div className="flex flex-wrap gap-2">
										<Button type="button" variant="primary" disabled={busy} onClick={() => void applySetup()}>
											{pending === "apply" ? "Setting up…" : "Apply"}
										</Button>
										<Button type="button" variant="ghost" disabled={busy} onClick={() => setPlan(null)}>
											Cancel
										</Button>
									</div>
								)}
							</div>
						)}

						{applied && (
							<div className="space-y-2" aria-live="polite">
								<ul className="space-y-1.5">
									{applied.results.map((r) => (
										<li key={r.id} className="flex items-start gap-2 text-sm">
											<StatusIcon ok={r.ok} />
											<span>{r.message}</span>
										</li>
									))}
								</ul>
								{applied.results.every((r) => r.ok) && (
									<p className="text-sm text-kumo-subtle">
										{applied.check?.ok
											? "The media host works. Save to start using it."
											: "Done. A new custom domain can take a few minutes to get its certificate: select Check again shortly, then save."}
									</p>
								)}
							</div>
						)}
					</SettingsSection>
				</form>
			)}

			{saved && <SaveBar form="cw-images-form" dirty={dirty} saving={pending === "save"} canSave={!busy} onDiscard={() => apply(saved)} />}
		</div>
	);
}
