/**
 * WordPress import page: the steps for moving a site that used Coywolf's
 * WordPress plugins. Preparing the export runs in the browser (the file never
 * leaves the computer until it's imported); converting stored content runs on
 * the site, a dry run first. Turning the module on or off happens on the
 * Coywolf Pack page.
 */
import { Banner, Button, InputArea, Loader } from "@cloudflare/kumo";
import { ArrowsClockwise, DownloadSimple, FileArrowUp, MagnifyingGlass, UploadSimple } from "@phosphor-icons/react";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import * as React from "react";

import { type PrepareWxrResult, prepareWxr } from "../wpImport/prepare.js";
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

function PrepareStep() {
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
			setResult({ ...prepareWxr(xml), name: file.name });
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
						{result.posts.length.toLocaleString()} {result.posts.length === 1 ? "entry" : "entries"} changed. Blocks marked “→ html” keep their
						content as HTML blocks, “→ flag” leaves an empty marker for the theme, and “→ removed” rendered nothing on WordPress.
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
								No Coywolf Pack block for these (yet). Their content is kept; “marker:disclosure”, “marker:podcast-links” and “marker:gravity-form” are
								empty placeholders for the theme. See the README.
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

// ── 4. Files and videos ──────────────────────────────────────────

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
			title="4. Coywolf Files downloads"
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
			title="5. Video Manager library"
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
	return (
		<div className="space-y-6">
			<header className="grid min-w-0 gap-2 border-b border-kumo-line pb-4">
				<h1 className="flex min-h-9 items-center text-2xl font-semibold leading-tight">WordPress import</h1>
				<p className="text-sm leading-5 text-pretty text-kumo-subtle">
					Move content that used Coywolf's WordPress plugins: Cloudflare Stream and Video Manager videos become Coywolf Video blocks, reviews become
					Coywolf Review blocks, tables of contents and heading ids carry over, and Coywolf Files downloads keep their links. Turn on Videos, Reviews,
					Headings &amp; TOC and File Downloads on the Coywolf Pack page before importing. The README has the full checklist.
				</p>
			</header>
			<PrepareStep />
			<DefaultsStep />
			<ConvertStep />
			<FilesStep />
			<VideosStep />
		</div>
	);
}
