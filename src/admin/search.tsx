/**
 * Search admin page: which collections are searchable, field weights, the
 * tokenizer, and index rebuilds. A thin UI over EmDash's own search API
 * (/_emdash/api/search/{enable,rebuild,stats}), called from the browser so
 * EmDash's permission checks apply. The pack route only reads the current
 * configuration, which EmDash has no endpoint for.
 */
import { Badge, Banner, Button, Input, Loader, Meter, Select, Switch } from "@cloudflare/kumo";
import { ArrowsClockwise, MagnifyingGlass } from "@phosphor-icons/react";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import * as React from "react";

const PACK_API = "/_emdash/api/plugins/coywolf-pack/search";
const SEARCH_API = "/_emdash/api/search";

const TOKENIZERS = [
	{ value: "porter unicode61", label: "English stemming (porter): “running” finds “run”" },
	{ value: "unicode61", label: "Exact words (unicode61): any language, no stemming" },
	{ value: "trigram", label: "Substrings (trigram): matches inside words; larger index" },
];

interface Field {
	slug: string;
	label: string;
	type: string;
	searchable: boolean;
}

interface CollectionConfig {
	slug: string;
	label: string;
	enabled: boolean;
	weights: Record<string, number>;
	tokenize: string;
	titleField: string | null;
	fields: Field[];
}

type Stats = Record<string, { indexed: number }>;

const errorText = (cause: unknown, fallback: string) => (cause instanceof Error && cause.message ? cause.message : fallback);

async function post<T>(path: string, body: unknown, fallback: string): Promise<T> {
	const response = await apiFetch(`${SEARCH_API}/${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return parseApiResponse<T>(response, fallback);
}

function CollectionCard(props: {
	collection: CollectionConfig;
	indexed: number | undefined;
	busy: boolean;
	onEnable: (enabled: boolean) => Promise<void>;
	onSave: (weights: Record<string, number>, tokenize: string) => Promise<void>;
	onRebuild: () => Promise<void>;
}) {
	const { collection } = props;
	const searchable = collection.fields.filter((f) => f.searchable);
	const [weights, setWeights] = React.useState<Record<string, string>>({});
	const [tokenize, setTokenize] = React.useState(collection.tokenize);
	React.useEffect(() => {
		setWeights(Object.fromEntries(searchable.map((f) => [f.slug, String(collection.weights[f.slug] ?? 1)])));
		setTokenize(collection.tokenize);
		// biome-ignore lint/correctness/useExhaustiveDependencies: reset when the saved config changes.
	}, [collection]);

	const parsed = Object.fromEntries(Object.entries(weights).map(([k, v]) => [k, Number(v)]));
	const invalid = Object.values(parsed).some((n) => !Number.isFinite(n) || n < 0 || n > 100);
	const dirty =
		tokenize !== collection.tokenize || searchable.some((f) => parsed[f.slug] !== (collection.weights[f.slug] ?? 1));
	const headingId = `cw-search-${collection.slug}`;

	return (
		<section aria-labelledby={headingId} className="rounded-lg border border-kumo-line">
			<div className="flex items-start justify-between gap-4 p-4">
				<div className="min-w-0">
					<h2 id={headingId} className="flex items-center gap-2 text-base font-semibold">
						{collection.label}
						<code className="text-xs font-normal text-kumo-subtle">{collection.slug}</code>
					</h2>
					<p className="mt-1 text-sm text-kumo-subtle">
						{searchable.length === 0
							? "No searchable fields. Mark fields as searchable in this collection's schema first."
							: collection.enabled
								? `${props.indexed === undefined ? "—" : props.indexed.toLocaleString()} entries indexed · searching ${searchable.map((f) => f.label).join(", ")}`
								: "Not searchable."}
					</p>
				</div>
				<Switch
					aria-label={`Search ${collection.label}: ${collection.enabled ? "on" : "off"}`}
					checked={collection.enabled}
					disabled={props.busy || searchable.length === 0}
					onCheckedChange={(on) => void props.onEnable(on)}
				/>
			</div>
			{collection.enabled && searchable.length > 0 && (
				<form
					className="space-y-4 border-t border-kumo-line p-4"
					onSubmit={(e) => {
						e.preventDefault();
						if (!invalid) void props.onSave(parsed, tokenize);
					}}
				>
					<fieldset style={{ minWidth: 0 }}>
						<legend className="text-sm font-medium">Field weights</legend>
						<p className="mt-0.5 text-sm text-kumo-subtle">
							How much a match in each field counts toward ranking. 1 is normal; 0 ignores the field for ranking.
						</p>
						<div className="mt-2 grid gap-3 sm:grid-cols-3">
							{searchable.map((f) => (
								<Input
									key={f.slug}
									label={f.label}
									type="number"
									min={0}
									max={100}
									step={0.5}
									inputMode="decimal"
									value={weights[f.slug] ?? "1"}
									onChange={(e: React.ChangeEvent<HTMLInputElement>) => setWeights((w) => ({ ...w, [f.slug]: e.target.value }))}
								/>
							))}
						</div>
					</fieldset>
					<Select
						label="Tokenizer"
						value={tokenize}
						onValueChange={(value: string | null) => setTokenize(value ?? "porter unicode61")}
						items={TOKENIZERS}
					/>
					{invalid && <p className="text-sm text-kumo-danger">Weights must be numbers from 0 to 100.</p>}
					<div className="flex flex-wrap justify-end gap-2">
						<Button type="button" variant="secondary" icon={<ArrowsClockwise />} disabled={props.busy} onClick={() => void props.onRebuild()}>
							Rebuild index
						</Button>
						<Button type="submit" variant="primary" disabled={props.busy || !dirty || invalid}>
							Save and rebuild
						</Button>
					</div>
				</form>
			)}
		</section>
	);
}

export function SearchPage() {
	const [collections, setCollections] = React.useState<CollectionConfig[]>();
	const [stats, setStats] = React.useState<Stats>({});
	const [error, setError] = React.useState<string>();
	const [status, setStatus] = React.useState("");
	const [progress, setProgress] = React.useState<{ done: number; total: number; current: string } | null>(null);

	const loadStats = React.useCallback(async () => {
		try {
			const data = await parseApiResponse<{ collections: Stats }>(await apiFetch(`${SEARCH_API}/stats`), "Couldn't load index stats");
			setStats(data.collections ?? {});
		} catch (cause) {
			setError(errorText(cause, "Couldn't load index stats"));
		}
	}, []);

	const load = React.useCallback(async () => {
		setError(undefined);
		try {
			const data = await parseApiResponse<{ collections: CollectionConfig[] }>(
				await apiFetch(`${PACK_API}/config`),
				"Couldn't load search settings",
			);
			setCollections(data.collections);
			await loadStats();
		} catch (cause) {
			setError(errorText(cause, "Couldn't load search settings"));
		}
	}, [loadStats]);

	React.useEffect(() => {
		void load();
	}, [load]);

	const busy = progress !== null;

	/** Run one or more index jobs with a progress readout, then refresh. */
	async function run(jobs: Array<{ label: string; fn: () => Promise<unknown> }>, done: string) {
		setError(undefined);
		setProgress({ done: 0, total: jobs.length, current: jobs[0]?.label ?? "" });
		setStatus(`Working on ${jobs[0]?.label ?? ""}…`);
		try {
			for (const [i, job] of jobs.entries()) {
				setProgress({ done: i, total: jobs.length, current: job.label });
				setStatus(`${job.label} (${i + 1} of ${jobs.length})…`);
				await job.fn();
			}
			setStatus(done);
		} catch (cause) {
			setError(errorText(cause, "The search index couldn't be updated"));
			setStatus("");
		} finally {
			setProgress(null);
			await load();
		}
	}

	const enabled = (collections ?? []).filter((c) => c.enabled);

	return (
		<div className="space-y-6">
			<header className="grid min-w-0 gap-4 border-b border-kumo-line pb-4">
				<div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1">
					<h1 className="flex min-h-9 min-w-0 items-center text-2xl font-semibold leading-tight">Search</h1>
					<div className="flex shrink-0 justify-end gap-2">
						<Button
							variant="secondary"
							icon={<ArrowsClockwise />}
							disabled={busy || enabled.length === 0}
							onClick={() =>
								void run(
									enabled.map((c) => ({
										label: `Rebuilding ${c.label}`,
										fn: () => post("rebuild", { collection: c.slug }, `Couldn't rebuild ${c.label}`),
									})),
									"All search indexes rebuilt.",
								)
							}
						>
							Rebuild all
						</Button>
					</div>
					<p className="col-span-2 text-sm leading-5 text-pretty text-kumo-subtle">
						EmDash's full-text search: choose which collections are searchable, how much each field counts, and how words
						are matched. Changing weights or the tokenizer rebuilds that collection's index. Fields are made searchable in
						each collection's schema.
					</p>
				</div>
			</header>

			<div role="status" aria-live="polite" className="space-y-2">
				{progress && (
					<Meter
						label={progress.current}
						value={Math.round((progress.done / Math.max(progress.total, 1)) * 100)}
						customValue={`${progress.done} of ${progress.total}`}
					/>
				)}
				{!progress && status && <Banner variant="default" title={status} />}
			</div>
			{error && <Banner variant="error" role="alert" title="Something went wrong" description={error} />}

			{!collections && !error ? (
				<div className="flex justify-center py-12">
					<Loader />
				</div>
			) : collections && collections.length === 0 ? (
				<div className="py-10 text-center text-kumo-subtle">
					<MagnifyingGlass size={40} className="mx-auto mb-3 opacity-30" aria-hidden="true" />
					<p className="text-base font-medium">No collections yet</p>
				</div>
			) : (
				collections?.map((c) => (
					<CollectionCard
						key={c.slug}
						collection={c}
						indexed={stats[c.slug]?.indexed}
						busy={busy}
						onEnable={async (on) => {
							if (!on && !window.confirm(`Turn off search for ${c.label}? Its search index is deleted; your settings are kept.`)) return;
							await run(
								[
									{
										label: on ? `Indexing ${c.label}` : `Turning off search for ${c.label}`,
										fn: () => post("enable", { collection: c.slug, enabled: on }, "Couldn't change search"),
									},
								],
								on ? `${c.label} is searchable.` : `Search is off for ${c.label}.`,
							);
						}}
						onSave={(weights, tokenize) =>
							run(
								[
									{
										label: `Rebuilding ${c.label}`,
										fn: () => post("enable", { collection: c.slug, enabled: true, weights, tokenize }, "Couldn't save"),
									},
								],
								`Saved. ${c.label}'s index was rebuilt.`,
							)
						}
						onRebuild={() =>
							run(
								[{ label: `Rebuilding ${c.label}`, fn: () => post("rebuild", { collection: c.slug }, `Couldn't rebuild ${c.label}`) }],
								`${c.label}'s index was rebuilt.`,
							)
						}
					/>
				))
			)}
		</div>
	);
}
