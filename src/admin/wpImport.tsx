/**
 * WordPress import page: the steps for moving a site that used Coywolf's
 * WordPress plugins. Preparing the export runs in the browser (the file never
 * leaves the computer until it's imported); converting stored content runs on
 * the site, a dry run first. Turning the module on or off happens on the
 * Coywolf Pack page.
 */
import { Banner, Button, InputArea, Loader } from "@cloudflare/kumo";
import { ArrowsClockwise, DownloadSimple, FileArrowUp, MagnifyingGlass, UploadSimple, UserPlus } from "@phosphor-icons/react";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import * as React from "react";

import { type GuestAuthor, type GuestByline, collectionFor, groupGuests, sameName, wxrGuestAuthors } from "../wpImport/guests.js";
import { type PrepareWxrResult, prepareWxr, wxrAttachments } from "../wpImport/prepare.js";
import { saveFile } from "./download.js";

const API = "/_emdash/api/plugins/coywolf-pack/wpImport";

const errorText = (cause: unknown, fallback: string) => (cause instanceof Error && cause.message ? cause.message : fallback);

async function post<T>(path: string, body: unknown, fallback: string): Promise<T> {
	const response = await apiFetch(`${API}/${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return parseApiResponse<T>(response, fallback);
}

function Section(props: { title: string; description: React.ReactNode; children: React.ReactNode }) {
	const id = `cw-wpi-${props.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
	return (
		<section className="rounded-lg border border-kumo-line" aria-labelledby={id}>
			<div className="border-b border-kumo-line p-4">
				<h2 id={id} className="text-base font-semibold">
					{props.title}
				</h2>
				<div className="mt-1 text-sm text-kumo-subtle">{props.description}</div>
			</div>
			<div className="space-y-4 p-4">{props.children}</div>
		</section>
	);
}

const Code = ({ children }: { children: string }) => <code className="rounded bg-kumo-tint px-1 py-0.5 font-mono text-xs break-all">{children}</code>;

function CountsTable({ counts }: { counts: Record<string, number> }) {
	const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
	if (!rows.length) return <p className="text-sm text-kumo-subtle">Nothing to change.</p>;
	return (
		<div className="overflow-x-auto">
			<table className="w-full text-left text-sm">
				<thead className="text-kumo-subtle">
					<tr>
						<th className="py-1 pe-3 font-medium">Block</th>
						<th className="py-1 text-end font-medium">Count</th>
					</tr>
				</thead>
				<tbody>
					{rows.map(([k, v]) => (
						<tr key={k} className="border-t border-kumo-line">
							<td className="py-1 pe-3 font-mono text-xs">{k}</td>
							<td className="py-1 text-end tabular-nums">{v.toLocaleString()}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

// ── 1. Prepare ───────────────────────────────────────────────────

function PrepareStep({ onGuests }: { onGuests: (guests: GuestAuthor[]) => void }) {
	const fileRef = React.useRef<HTMLInputElement>(null);
	const [busy, setBusy] = React.useState(false);
	const [error, setError] = React.useState<string>();
	const [result, setResult] = React.useState<(PrepareWxrResult & { name: string }) | null>(null);

	const choose = async (file: File) => {
		setBusy(true);
		setError(undefined);
		setResult(null);
		try {
			const xml = await file.text();
			if (!xml.includes("<rss") || !xml.includes("<wp:")) throw new Error("That doesn't look like a WordPress export (WXR) file.");
			// Let the "Reading…" state paint before the synchronous work.
			await new Promise((r) => setTimeout(r, 0));
			const prepared = prepareWxr(xml);
			setResult({ ...prepared, name: file.name });
			onGuests(prepared.guestAuthors);
		} catch (cause) {
			setError(errorText(cause, "Could not read that file."));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Section
			title="1. Prepare the WordPress export"
			description={
				<>
					EmDash's importer drops blocks it doesn't know and heading ids. Choose the export from <strong>Tools → Export</strong> in WordPress, then
					import the prepared copy under <strong>Settings → Import</strong>. The file is processed in your browser and isn't uploaded.
				</>
			}
		>
			<input
				ref={fileRef}
				type="file"
				accept=".xml,text/xml,application/xml"
				className="sr-only"
				tabIndex={-1}
				aria-hidden="true"
				onChange={(e) => {
					const file = e.target.files?.[0];
					e.target.value = "";
					if (file) void choose(file);
				}}
			/>
			<div className="flex flex-wrap gap-2">
				<Button variant="secondary" icon={<FileArrowUp />} disabled={busy} onClick={() => fileRef.current?.click()}>
					{busy ? "Reading…" : "Choose export file"}
				</Button>
				{result && (
					<Button
						variant="primary"
						icon={<DownloadSimple />}
						onClick={() => saveFile(new Blob([result.xml], { type: "application/xml" }), result.name.replace(/\.xml$/i, "") + "-prepared.xml")}
					>
						Download prepared file
					</Button>
				)}
			</div>
			{error && <Banner variant="error" role="alert" description={error} />}
			{result && (
				<div className="space-y-2" role="status">
					<p className="text-sm">
						{result.posts.length.toLocaleString()} {result.posts.length === 1 ? "entry" : "entries"} changed. Blocks marked “→ note”, “→ details”, “→ quote” and
						“→ disclosure” become Content Blocks, “→ html” keep their content as HTML blocks, “→ flag” leaves an empty marker for the theme, and “→ removed” rendered nothing on WordPress.
						{result.guestAuthors.length ? ` ${result.guestAuthors.length} ${result.guestAuthors.length === 1 ? "post has" : "posts have"} a guest author: credit them in step 4 after importing.` : ""}
					</p>
					<CountsTable counts={result.counts} />
				</div>
			)}
		</Section>
	);
}

// ── 2. Defaults ──────────────────────────────────────────────────

function DefaultsStep() {
	const [cvm, setCvm] = React.useState("");
	const [files, setFiles] = React.useState("");
	const [saved, setSaved] = React.useState<unknown>(null);
	const [error, setError] = React.useState<string>();
	const [busy, setBusy] = React.useState(false);

	React.useEffect(() => {
		void apiFetch(`${API}/settings`)
			.then((r) => parseApiResponse<{ defaults: unknown }>(r, "Could not load the settings"))
			.then((d) => setSaved(d.defaults))
			.catch(() => setSaved(null));
	}, []);

	const save = async () => {
		setBusy(true);
		setError(undefined);
		try {
			const parse = (text: string, label: string) => {
				if (!text.trim()) return undefined;
				try {
					return JSON.parse(text) as unknown;
				} catch {
					throw new Error(`The ${label} isn't valid JSON.`);
				}
			};
			const d = await post<{ defaults: unknown }>("settings/save", { cvm: parse(cvm, "Video Manager settings"), files: parse(files, "Coywolf Files settings") }, "Could not save");
			setSaved(d.defaults);
		} catch (cause) {
			setError(errorText(cause, "Could not save"));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Section
			title="2. Player and download card defaults (optional)"
			description="Video Manager and Coywolf Files blocks that didn't set an option used the plugin's settings. Paste them so converted blocks look the same. Without them, the plugins' own defaults are used."
		>
			<div className="grid gap-4 lg:grid-cols-2">
				<div className="space-y-1">
					<InputArea label="Video Manager settings (JSON)" rows={4} className="font-mono text-xs" value={cvm} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setCvm(e.target.value)} />
					<p className="text-xs text-kumo-subtle">
						<Code>wp option get coywolf_cvm_settings --format=json</Code>
					</p>
				</div>
				<div className="space-y-1">
					<InputArea label="Coywolf Files settings (JSON)" rows={4} className="font-mono text-xs" value={files} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setFiles(e.target.value)} />
					<p className="text-xs text-kumo-subtle">
						<Code>wp option get coywolf_files_settings --format=json</Code>
					</p>
				</div>
			</div>
			<div className="flex items-center gap-3">
				<Button variant="secondary" disabled={busy || (!cvm.trim() && !files.trim())} onClick={() => void save()}>
					Save defaults
				</Button>
				{saved !== null && <span className="text-xs text-kumo-subtle">Saved: {JSON.stringify(saved)}</span>}
			</div>
			{error && <Banner variant="error" role="alert" description={error} />}
		</Section>
	);
}

// ── 3. Convert ───────────────────────────────────────────────────

interface ScanEntry {
	collection: string;
	id: string;
	title: string;
	status: string;
	changes: Record<string, number>;
	result?: string;
	error?: string;
}

interface ScanPage {
	done: boolean;
	scanned: number;
	entries: ScanEntry[];
	leftovers: Record<string, number>;
	videosAdded: number;
	state: unknown;
	progress: string;
}

interface ScanReport {
	apply: boolean;
	scanned: number;
	entries: ScanEntry[];
	leftovers: Record<string, number>;
	videosAdded: number;
	done: boolean;
}

const RESULT_LABEL: Record<string, string> = {
	updated: "Updated",
	published: "Updated and republished",
	draft: "Updated in its draft (it had unpublished changes)",
	conflict: "Skipped: changed while converting",
	failed: "Failed",
};

function ConvertStep() {
	const [report, setReport] = React.useState<ScanReport | null>(null);
	const [running, setRunning] = React.useState<false | "dry" | "apply">(false);
	const [progress, setProgress] = React.useState("");
	const [error, setError] = React.useState<string>();
	const [dryRunDone, setDryRunDone] = React.useState(false);

	const run = async (apply: boolean) => {
		if (apply && !window.confirm("Convert the blocks listed in the dry run? Each entry is saved (published entries are republished). Make a backup first.")) return;
		setRunning(apply ? "apply" : "dry");
		setError(undefined);
		const acc: ScanReport = { apply, scanned: 0, entries: [], leftovers: {}, videosAdded: 0, done: false };
		setReport(acc);
		try {
			let state: unknown = null;
			for (;;) {
				const page = await post<ScanPage>("scan", { apply, state }, "The scan failed");
				acc.scanned += page.scanned;
				acc.entries.push(...page.entries);
				acc.videosAdded += page.videosAdded;
				for (const [k, v] of Object.entries(page.leftovers)) acc.leftovers[k] = (acc.leftovers[k] ?? 0) + v;
				setProgress(`${page.progress}: ${acc.scanned.toLocaleString()} entries checked`);
				setReport({ ...acc, entries: [...acc.entries] });
				if (page.done) break;
				state = page.state;
			}
			acc.done = true;
			setReport({ ...acc, entries: [...acc.entries] });
			if (!apply) setDryRunDone(true);
		} catch (cause) {
			setError(errorText(cause, "The scan failed"));
		} finally {
			setRunning(false);
			setProgress("");
		}
	};

	const totals: Record<string, number> = {};
	for (const e of report?.entries ?? []) for (const [k, v] of Object.entries(e.changes)) totals[k] = (totals[k] ?? 0) + v;

	return (
		<Section
			title="3. Convert imported content"
			description="While WordPress import is on, entries are converted as they're imported or saved. This converts entries that are already on the site (imported earlier, or before the module was on). Run a dry run first: it lists what would change and changes nothing."
		>
			<div className="flex flex-wrap gap-2">
				<Button variant="secondary" icon={<MagnifyingGlass />} disabled={Boolean(running)} onClick={() => void run(false)}>
					{running === "dry" ? "Checking…" : "Dry run"}
				</Button>
				<Button variant="primary" icon={<ArrowsClockwise />} disabled={Boolean(running) || !dryRunDone || !report?.entries.length} onClick={() => void run(true)}>
					{running === "apply" ? "Converting…" : "Convert"}
				</Button>
				{running && <Loader size="sm" />}
			</div>
			<p className="sr-only" role="status" aria-live="polite">
				{progress}
			</p>
			{progress && <p className="text-sm text-kumo-subtle">{progress}</p>}
			{error && <Banner variant="error" role="alert" description={error} />}
			{report && (
				<div className="space-y-4">
					<p className="text-sm">
						{report.done ? (report.apply ? "Converted. " : "Dry run finished. ") : ""}
						{report.entries.length.toLocaleString()} of {report.scanned.toLocaleString()} entries {report.apply ? "had" : "have"} blocks to convert.
						{report.apply && report.videosAdded ? ` Added details for ${report.videosAdded} videos.` : ""}
					</p>
					{Object.keys(totals).length > 0 && (
						<div>
							<h3 className="mb-1 text-sm font-medium">{report.apply ? "Converted" : "Would convert"}</h3>
							<CountsTable counts={totals} />
						</div>
					)}
					{Object.keys(report.leftovers).length > 0 && (
						<div>
							<h3 className="mb-1 text-sm font-medium">Kept as HTML blocks</h3>
							<p className="mb-1 text-xs text-kumo-subtle">
								No Coywolf Pack block for these (yet), or the block is turned off (notes, transcripts, quotes and disclosures convert once their
								Content Blocks switch is on: run this again). Their content is kept; “marker:podcast-links” and “marker:gravity-form” are empty
								placeholders for the theme. See the README.
							</p>
							<CountsTable counts={report.leftovers} />
						</div>
					)}
					{report.entries.length > 0 && (
						<div className="overflow-x-auto">
							<table className="w-full text-left text-sm">
								<thead className="text-kumo-subtle">
									<tr>
										<th className="py-1 pe-3 font-medium">Entry</th>
										<th className="py-1 pe-3 font-medium">Status</th>
										<th className="py-1 pe-3 font-medium">Changes</th>
										{report.apply && <th className="py-1 font-medium">Result</th>}
									</tr>
								</thead>
								<tbody>
									{report.entries.slice(0, 1000).map((e) => (
										<tr key={`${e.collection}/${e.id}`} className="border-t border-kumo-line align-top">
											<td className="py-1 pe-3">
												<a className="text-kumo-link underline" href={`/_emdash/admin/content/${encodeURIComponent(e.collection)}/${encodeURIComponent(e.id)}`}>
													{e.title || e.id}
												</a>
												<span className="block text-xs text-kumo-subtle">{e.collection}</span>
											</td>
											<td className="py-1 pe-3">{e.status}</td>
											<td className="py-1 pe-3 text-xs">
												{Object.entries(e.changes)
													.map(([k, v]) => `${k} × ${v}`)
													.join(", ")}
											</td>
											{report.apply && (
												<td className="py-1 text-xs">
													{RESULT_LABEL[e.result ?? ""] ?? e.result ?? ""}
													{e.error ? `: ${e.error}` : ""}
												</td>
											)}
										</tr>
									))}
								</tbody>
							</table>
							{report.entries.length > 1000 && <p className="mt-1 text-xs text-kumo-subtle">Showing the first 1,000 entries.</p>}
						</div>
					)}
				</div>
			)}
		</Section>
	);
}

// ── 4. Guest author bylines ──────────────────────────────────────

const EMDASH = "/_emdash/api";

interface BylineSummary {
	id: string;
	slug: string;
	displayName: string;
	isGuest: boolean;
	avatarMediaId: string | null;
}

interface PostPlan {
	guest: GuestAuthor;
	collection: string;
	entryId?: string;
	entryTitle?: string;
	/** Names of the bylines credited now (explicitly). */
	current: string[];
	action: "credit" | "done" | "missing";
	result?: string;
}

interface BylinePlan {
	byline: GuestByline;
	existing: BylineSummary | null;
	avatarMediaId: string | null;
	posts: PostPlan[];
	result?: string;
}

async function getJson<T>(url: string, fallback: string): Promise<T> {
	return parseApiResponse<T>(await apiFetch(url), fallback);
}

async function send<T>(url: string, method: "POST" | "PUT", body: unknown, fallback: string): Promise<T> {
	const response = await apiFetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
	return parseApiResponse<T>(response, fallback);
}

/** Look up what's on the site for each guest: an existing byline with that name, the avatar in the media library, the imported entries and their credits. */
async function planGuests(groups: GuestByline[]): Promise<BylinePlan[]> {
	const plans: BylinePlan[] = [];
	for (const byline of groups) {
		const found = await getJson<{ items: BylineSummary[] }>(`${EMDASH}/admin/bylines?search=${encodeURIComponent(byline.name)}&limit=50`, "Could not list bylines");
		const matches = found.items.filter((b) => sameName(b.displayName, byline.name));
		const existing = matches.find((b) => b.isGuest) ?? matches[0] ?? null;
		let avatarMediaId: string | null = existing?.avatarMediaId ?? null;
		if (!avatarMediaId && byline.avatarFile) {
			const media = await getJson<{ items: Array<{ id: string; filename: string }> }>(
				`${EMDASH}/media?q=${encodeURIComponent(byline.avatarFile)}&limit=20`,
				"Could not search the media library",
			).catch(() => ({ items: [] }));
			avatarMediaId = media.items.find((m) => m.filename.toLowerCase() === byline.avatarFile.toLowerCase())?.id ?? null;
		}
		const posts: PostPlan[] = [];
		for (const guest of byline.posts) {
			const collection = collectionFor(guest.postType);
			try {
				const { item } = await getJson<{ item: { id: string; data?: Record<string, unknown>; bylines?: Array<{ byline: { id: string; displayName: string }; source?: string }> } }>(
					`${EMDASH}/content/${encodeURIComponent(collection)}/${encodeURIComponent(guest.slug)}`,
					"Not found",
				);
				const explicit = (item.bylines ?? []).filter((c) => c.source !== "inferred");
				const done = Boolean(existing) && explicit.length === 1 && explicit[0]?.byline.id === existing?.id;
				posts.push({
					guest,
					collection,
					entryId: item.id,
					entryTitle: typeof item.data?.title === "string" ? item.data.title : guest.title,
					current: (item.bylines ?? []).map((c) => c.byline.displayName),
					action: done ? "done" : "credit",
				});
			} catch {
				posts.push({ guest, collection, current: [], action: "missing" });
			}
		}
		plans.push({ byline, existing, avatarMediaId, posts });
	}
	return plans;
}

/** Create a guest byline, trying "-2", "-3", … if the slug is taken. */
async function createByline(plan: BylinePlan): Promise<BylineSummary> {
	const b = plan.byline;
	let lastError: unknown;
	for (let n = 1; n <= 5; n++) {
		try {
			return await send<BylineSummary>(
				`${EMDASH}/admin/bylines`,
				"POST",
				{ slug: n === 1 ? b.slug : `${b.slug}-${n}`, displayName: b.name, bio: b.bio || null, websiteUrl: b.url || null, avatarMediaId: plan.avatarMediaId, isGuest: true },
				"Could not create the byline",
			);
		} catch (error) {
			lastError = error;
			if (!/slug|exists|unique|conflict/i.test(String(error))) break;
		}
	}
	throw lastError instanceof Error ? lastError : new Error("Could not create the byline");
}

function GuestBylinesStep({ guests, onGuests }: { guests: GuestAuthor[] | null; onGuests: (guests: GuestAuthor[]) => void }) {
	const fileRef = React.useRef<HTMLInputElement>(null);
	const [plans, setPlans] = React.useState<BylinePlan[] | null>(null);
	const [running, setRunning] = React.useState<false | "read" | "dry" | "apply">(false);
	const [applied, setApplied] = React.useState(false);
	const [error, setError] = React.useState<string>();
	const groups = React.useMemo(() => (guests ? groupGuests(guests) : []), [guests]);

	React.useEffect(() => {
		setPlans(null);
		setApplied(false);
	}, [guests]);

	const choose = async (file: File) => {
		setRunning("read");
		setError(undefined);
		try {
			const xml = await file.text();
			if (!xml.includes("<rss") || !xml.includes("<wp:")) throw new Error("That doesn't look like a WordPress export (WXR) file.");
			onGuests(wxrGuestAuthors(xml, wxrAttachments(xml)));
		} catch (cause) {
			setError(errorText(cause, "Could not read that file."));
		} finally {
			setRunning(false);
		}
	};

	const dryRun = async () => {
		setRunning("dry");
		setError(undefined);
		setApplied(false);
		try {
			setPlans(await planGuests(groups));
		} catch (cause) {
			setError(errorText(cause, "The dry run failed"));
		} finally {
			setRunning(false);
		}
	};

	const apply = async () => {
		if (!plans) return;
		if (!window.confirm("Create the guest bylines and credit the posts listed? Each post's current byline is replaced by its guest.")) return;
		setRunning("apply");
		setError(undefined);
		const next = plans.map((p) => ({ ...p, posts: p.posts.map((x) => ({ ...x })) }));
		for (const plan of next) {
			let bylineId = plan.existing?.id;
			if (!bylineId && plan.posts.some((x) => x.action === "credit")) {
				try {
					const created = await createByline(plan);
					plan.existing = created;
					bylineId = created.id;
					plan.result = `Created byline “${created.displayName}” (${created.slug})`;
				} catch (cause) {
					plan.result = `Could not create the byline: ${errorText(cause, "unknown error")}`;
					continue;
				}
			}
			for (const post of plan.posts) {
				if (post.action !== "credit" || !post.entryId || !bylineId) continue;
				try {
					await send(`${EMDASH}/content/${encodeURIComponent(post.collection)}/${encodeURIComponent(post.entryId)}`, "PUT", { bylines: [{ bylineId }] }, "Could not update the entry");
					post.action = "done";
					post.result = "Credited";
				} catch (cause) {
					post.result = `Failed: ${errorText(cause, "unknown error")}`;
				}
			}
			setPlans(next.map((p) => ({ ...p })));
		}
		setPlans(next);
		setApplied(true);
		setRunning(false);
	};

	const toCredit = plans?.reduce((n, p) => n + p.posts.filter((x) => x.action === "credit").length, 0) ?? 0;
	const toCreate = plans?.filter((p) => !p.existing && p.posts.some((x) => x.action === "credit")).length ?? 0;

	return (
		<Section
			title="4. Guest author bylines"
			description={
				<>
					Posts that had a guest author (Coywolf Guest Author plugin) were imported under their WordPress user. This creates a guest byline for
					each guest (name, website, bio, and avatar when it's in the media library) and credits their posts to it, so the byline, author schema
					and Review schema name the guest. It uses EmDash's own byline and content API with your account, a dry run first. Running it again
					changes nothing.
				</>
			}
		>
			<input
				ref={fileRef}
				type="file"
				accept=".xml,text/xml,application/xml"
				className="sr-only"
				tabIndex={-1}
				aria-hidden="true"
				onChange={(e) => {
					const file = e.target.files?.[0];
					e.target.value = "";
					if (file) void choose(file);
				}}
			/>
			<div className="flex flex-wrap items-center gap-2">
				{guests === null && (
					<Button variant="secondary" icon={<FileArrowUp />} disabled={Boolean(running)} onClick={() => fileRef.current?.click()}>
						{running === "read" ? "Reading…" : "Choose export file"}
					</Button>
				)}
				<Button variant="secondary" icon={<MagnifyingGlass />} disabled={Boolean(running) || !groups.length} onClick={() => void dryRun()}>
					{running === "dry" ? "Checking…" : "Dry run"}
				</Button>
				<Button variant="primary" icon={<UserPlus />} disabled={Boolean(running) || !plans || applied || (!toCredit && !toCreate)} onClick={() => void apply()}>
					{running === "apply" ? "Crediting…" : "Create bylines and credit posts"}
				</Button>
				{running && <Loader size="sm" />}
			</div>
			{error && <Banner variant="error" role="alert" description={error} />}
			{guests !== null && (
				<p className="text-sm" role="status">
					{guests.length
						? `${guests.length.toLocaleString()} ${guests.length === 1 ? "post has" : "posts have"} a guest author (${groups.length} ${groups.length === 1 ? "guest" : "guests"}).`
						: "No guest authors in this export."}
					{plans && !applied ? ` Dry run: ${toCreate} ${toCreate === 1 ? "byline" : "bylines"} to create, ${toCredit} ${toCredit === 1 ? "post" : "posts"} to credit.` : ""}
				</p>
			)}
			{plans && (
				<div className="overflow-x-auto">
					<table className="w-full text-left text-sm">
						<thead className="text-kumo-subtle">
							<tr>
								<th className="py-1 pe-3 font-medium">Guest</th>
								<th className="py-1 pe-3 font-medium">Post</th>
								<th className="py-1 pe-3 font-medium">Byline now</th>
								<th className="py-1 font-medium">{applied ? "Result" : "Will"}</th>
							</tr>
						</thead>
						<tbody>
							{plans.flatMap((plan) =>
								plan.posts.map((post, i) => (
									<tr key={`${plan.byline.slug}/${post.guest.slug}`} className="border-t border-kumo-line align-top">
										<td className="py-1 pe-3">
											{i === 0 ? (
												<>
													{plan.byline.name}
													<span className="block text-xs text-kumo-subtle">
														{plan.existing ? "Byline exists" : "New guest byline"}
														{plan.byline.url ? ` · ${plan.byline.url}` : ""}
														{plan.byline.avatarFile ? (plan.avatarMediaId ? " · avatar found" : ` · avatar ${plan.byline.avatarFile} not in the media library`) : ""}
													</span>
													{plan.result && <span className="block text-xs">{plan.result}</span>}
												</>
											) : null}
										</td>
										<td className="py-1 pe-3">
											{post.entryId ? (
												<a className="text-kumo-link underline" href={`/_emdash/admin/content/${encodeURIComponent(post.collection)}/${encodeURIComponent(post.entryId)}`}>
													{post.entryTitle || post.guest.title || post.guest.slug}
												</a>
											) : (
												post.guest.title || post.guest.slug
											)}
										</td>
										<td className="py-1 pe-3 text-xs">{post.current.join(", ") || "—"}</td>
										<td className="py-1 text-xs">
											{post.result ??
												(post.action === "done"
													? "Already credited"
													: post.action === "missing"
														? `Not found: no ${post.collection} entry with the slug “${post.guest.slug}”`
														: `Credit ${plan.byline.name}`)}
										</td>
									</tr>
								)),
							)}
						</tbody>
					</table>
				</div>
			)}
		</Section>
	);
}

// ── 5. Files and videos ──────────────────────────────────────────

const FILES_QUERY =
	'wp db query "SELECT file_id, object_key, filename, mime, size, downloads, created FROM wp_coywolf_files"';

function FilesStep() {
	const [text, setText] = React.useState("");
	const [busy, setBusy] = React.useState(false);
	const [message, setMessage] = React.useState("");
	const [error, setError] = React.useState<string>();
	const submit = async () => {
		setBusy(true);
		setError(undefined);
		setMessage("");
		try {
			const r = await post<{ added: number; errors: Array<{ row: number; error: string }> }>("files", { text }, "Import failed");
			setMessage(`Added ${r.added} ${r.added === 1 ? "file" : "files"}.${r.errors.length ? ` Skipped ${r.errors.length}: ${r.errors.map((e) => `row ${e.row} (${e.error})`).join("; ")}` : ""}`);
		} catch (cause) {
			setError(errorText(cause, "Import failed"));
		} finally {
			setBusy(false);
		}
	};
	return (
		<Section
			title="5. Coywolf Files downloads"
			description={
				<>
					Registers files uploaded with Coywolf Files so File download blocks and old download links keep working (they keep their WordPress ids;
					set the download URL base on Files → Settings to the old link base, e.g. <Code>coywolf-file</Code>). The files themselves must be in the
					bucket bound as <Code>FILES</Code> (or <Code>MEDIA</Code>) under the same keys. Paste the output of:
					<span className="mt-1 block">
						<Code>{FILES_QUERY}</Code>
					</span>
				</>
			}
		>
			<InputArea label="Coywolf Files records" rows={4} className="font-mono text-xs" value={text} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setText(e.target.value)} />
			<Button variant="secondary" icon={<UploadSimple />} disabled={busy || !text.trim()} onClick={() => void submit()}>
				Import file records
			</Button>
			{message && (
				<p className="text-sm" role="status">
					{message}
				</p>
			)}
			{error && <Banner variant="error" role="alert" description={error} />}
		</Section>
	);
}

function VideosStep() {
	const [fields, setFields] = React.useState({ descriptions: "", posters: "", downloads: "" });
	const [busy, setBusy] = React.useState(false);
	const [message, setMessage] = React.useState("");
	const [error, setError] = React.useState<string>();
	const submit = async () => {
		setBusy(true);
		setError(undefined);
		setMessage("");
		try {
			const body: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(fields)) {
				if (!v.trim()) continue;
				try {
					body[k] = JSON.parse(v);
				} catch {
					throw new Error(`The ${k} aren't valid JSON.`);
				}
			}
			const r = await post<{ updated: number }>("videos", body, "Import failed");
			setMessage(`Updated ${r.updated} ${r.updated === 1 ? "video" : "videos"}.`);
		} catch (cause) {
			setError(errorText(cause, "Import failed"));
		} finally {
			setBusy(false);
		}
	};
	const area = (key: keyof typeof fields, label: string, option: string) => (
		<div className="space-y-1">
			<InputArea label={label} rows={3} className="font-mono text-xs" value={fields[key]} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setFields((f) => ({ ...f, [key]: e.target.value }))} />
			<p className="text-xs text-kumo-subtle">
				<Code>{`wp option get ${option} --format=json`}</Code>
			</p>
		</div>
	);
	return (
		<Section
			title="6. Video Manager library"
			description="Per-video descriptions, poster frames or images, and MP4 download links set on Video Manager's Edit Video page. They're used in VideoObject schema and the video sitemap."
		>
			<div className="grid gap-4 lg:grid-cols-3">
				{area("descriptions", "Descriptions (JSON)", "coywolf_cvm_descriptions")}
				{area("posters", "Posters (JSON)", "coywolf_cvm_posters")}
				{area("downloads", "MP4 downloads (JSON)", "coywolf_cvm_downloads")}
			</div>
			<Button variant="secondary" icon={<UploadSimple />} disabled={busy || !Object.values(fields).some((v) => v.trim())} onClick={() => void submit()}>
				Import video details
			</Button>
			{message && (
				<p className="text-sm" role="status">
					{message}
				</p>
			)}
			{error && <Banner variant="error" role="alert" description={error} />}
		</Section>
	);
}

export function WpImportPage() {
	const [guests, setGuests] = React.useState<GuestAuthor[] | null>(null);
	return (
		<div className="space-y-6">
			<header className="grid min-w-0 gap-2 border-b border-kumo-line pb-4">
				<h1 className="flex min-h-9 items-center text-2xl font-semibold leading-tight">WordPress import</h1>
				<p className="text-sm leading-5 text-pretty text-kumo-subtle">
					Move content that used Coywolf's WordPress plugins: Cloudflare Stream and Video Manager videos become Coywolf Video blocks, reviews become
					Coywolf Review blocks, sidenotes, transcripts, quotes and affiliate disclosures become Note, Details, Quote and Affiliate disclosure blocks,
					tables of contents and heading ids carry over, guest authors get their own bylines, and Coywolf Files downloads keep their links. Turn on
					Videos, Reviews, Content Blocks (and each block), Headings &amp; TOC and File Downloads on the Coywolf Pack page before importing. The
					README has the full checklist.
				</p>
			</header>
			<PrepareStep onGuests={setGuests} />
			<DefaultsStep />
			<ConvertStep />
			<GuestBylinesStep guests={guests} onGuests={setGuests} />
			<FilesStep />
			<VideosStep />
		</div>
	);
}
