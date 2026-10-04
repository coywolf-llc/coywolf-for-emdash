/**
 * Robots.txt Rules admin page: named rules, a crawler picker backed by the
 * verified bot directory, a live preview of the generated file, and a URL
 * tester that runs Google's REP matcher (ported) against that preview.
 */
import { Badge, Banner, Button, Checkbox, Dialog, DropdownMenu, Input, InputArea, Loader, Select, Switch } from "@cloudflare/kumo";
import { ArrowDown, ArrowsClockwise, ArrowUp, CheckCircle, DotsThree, PencilSimple, Plus, Robot, Trash, WarningCircle, XCircle } from "@phosphor-icons/react";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import * as React from "react";

import { type BotEntry, CATEGORY_LABELS, categoryLabel } from "../robots/bots.js";
import { evaluate } from "../robots/rep.js";
import { type RobotsConfig, type RobotsRule, type RuleKind, directives, generate, isValidToken } from "../robots/rules.js";

const API = "/_emdash/api/plugins/coywolf-pack/robots";

interface SyncState {
	at: string;
	ok: boolean;
	total?: number;
	added?: number;
	updated?: number;
	delisted?: number;
	error?: string;
}

interface PageData {
	config: RobotsConfig;
	saved: boolean;
	siteUrl: string;
	emdashRobotsTxt: string | null;
	presets: Array<Omit<RobotsRule, "id" | "enabled">>;
	radar: { tokenConfigured: boolean; state: SyncState | null; baselineDate: string };
}

const KIND_LABELS: Record<RuleKind, string> = {
	entire_site: "The entire site",
	folder: "A folder",
	prefix: "Paths starting with",
	single_page: "A single page or file",
	exact_url: "An exact URL only",
	filetype: "A file type anywhere",
	filetype_in_folder: "A file type in a folder",
	contains: "URLs containing text",
	any_depth: "A folder at any depth",
	query_any: "All URLs with a query string",
	query_param: "A query parameter",
	wildcard_prefix: "A prefix with a wildcard",
	allow_exception: "Block a folder, allow one item in it",
	custom: "Custom value",
};
const PATH_LABELS: Partial<Record<RuleKind, [string, string]>> = {
	folder: ["Folder", "/private/"],
	prefix: ["Path prefix", "/drafts"],
	single_page: ["Path", "/thank-you/"],
	exact_url: ["Exact path", "/search"],
	filetype_in_folder: ["Folder", "/downloads/"],
	contains: ["Text", "preview="],
	any_depth: ["Folder name", "print"],
	query_param: ["Parameter name", "utm_source"],
	wildcard_prefix: ["Prefix", "/tag-"],
	allow_exception: ["Folder to block", "/members/"],
	custom: ["Value", "/*?replytocom="],
};

const errorText = (cause: unknown, fallback: string) => (cause instanceof Error && cause.message ? cause.message : fallback);
const newId = () => Math.random().toString(36).slice(2, 10);
const dateFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });

async function post<T>(path: string, body: unknown): Promise<T> {
	const response = await apiFetch(`${API}/${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return parseApiResponse<T>(response, "The request failed");
}

/** Token → entry; when several bots share a token, a verified entry wins. */
function tokenIndex(bots: BotEntry[]): Map<string, BotEntry> {
	const map = new Map<string, BotEntry>();
	for (const b of bots) {
		const key = b.token.toLowerCase();
		const have = map.get(key);
		if (!have || (have.status !== "verified" && b.status === "verified")) map.set(key, b);
	}
	return map;
}

function UnverifiedBadge({ bot }: { bot: BotEntry }) {
	if (bot.status === "verified") return null;
	return (
		<span title={bot.note ?? "This token hasn't been confirmed in the operator's documentation."}>
			<Badge variant="warning">unverified</Badge>
		</span>
	);
}

/** Pick crawlers from the directory, filtered by category and search. */
function BotPicker(props: { bots: BotEntry[]; selected: string[]; onChange: (agents: string[]) => void }) {
	const [query, setQuery] = React.useState("");
	const [category, setCategory] = React.useState("AI_CRAWLER");
	const [custom, setCustom] = React.useState("");
	const selected = new Set(props.selected.map((a) => a.toLowerCase()));
	const toggle = (token: string, on: boolean) =>
		props.onChange(on ? [...props.selected, token] : props.selected.filter((a) => a.toLowerCase() !== token.toLowerCase()));

	const q = query.trim().toLowerCase();
	const seen = new Set<string>();
	const visible = props.bots.filter((b) => {
		if (category !== "all" && b.category !== category) return false;
		if (q && !`${b.name} ${b.token} ${b.operator}`.toLowerCase().includes(q)) return false;
		const key = b.token.toLowerCase();
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	const categories = [...new Set(props.bots.map((b) => b.category))].sort((a, b) => categoryLabel(a).localeCompare(categoryLabel(b)));
	const byToken = tokenIndex(props.bots);

	return (
		<fieldset className="space-y-3">
			<legend className="text-sm font-medium">Crawlers</legend>
			<div className="flex flex-wrap gap-1" aria-live="polite">
				{props.selected.length === 0 && <span className="text-sm text-kumo-subtle">None picked yet.</span>}
				{props.selected.map((agent) => {
					const bot = byToken.get(agent.toLowerCase());
					return (
						<button
							key={agent}
							type="button"
							className="inline-flex items-center gap-1 rounded border border-kumo-line px-1.5 py-0.5 font-mono text-xs hover:bg-kumo-tint"
							onClick={() => toggle(agent, false)}
							aria-label={`Remove ${agent}`}
							title={bot?.status === "unverified" ? (bot.note ?? "Unverified token") : bot?.name}
						>
							{agent === "*" ? "* (all crawlers)" : agent}
							{bot?.status === "unverified" && <WarningCircle className="text-kumo-warning" aria-label="unverified" />}
							<XCircle aria-hidden="true" />
						</button>
					);
				})}
			</div>
			<Checkbox label="All crawlers (*)" checked={selected.has("*")} onCheckedChange={(on: boolean) => toggle("*", on)} />
			<div className="flex flex-col gap-2 sm:flex-row sm:items-end">
				<div className="sm:w-56">
					<Select
						label="Category"
						value={category}
						onValueChange={(v: string | null) => setCategory(v ?? "all")}
						items={[{ value: "all", label: "All categories" }, ...categories.map((c) => ({ value: c, label: CATEGORY_LABELS[c] ?? categoryLabel(c) }))]}
					/>
				</div>
				<div className="flex-1">
					<Input
						label="Search"
						placeholder="Name, token or operator"
						value={query}
						onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)}
					/>
				</div>
			</div>
			<div className="max-h-64 overflow-y-auto rounded border border-kumo-line" role="group" aria-label="Matching crawlers">
				{visible.slice(0, 150).map((bot) => (
					<label key={bot.slug} className="flex cursor-pointer items-start gap-2 border-b border-kumo-line px-3 py-2 text-sm last:border-0 hover:bg-kumo-tint/50">
						<input
							type="checkbox"
							className="mt-1"
							checked={selected.has(bot.token.toLowerCase())}
							onChange={(e) => toggle(bot.token, e.target.checked)}
						/>
						<span className="min-w-0 flex-1">
							<span className="flex flex-wrap items-center gap-1.5">
								<span className="font-medium">{bot.name}</span>
								<code className="text-xs">{bot.token}</code>
								<UnverifiedBadge bot={bot} />
								{bot.delisted && <Badge variant="outline">left Radar</Badge>}
							</span>
							<span className="block truncate text-xs text-kumo-subtle" title={bot.description}>
								{bot.operator}
								{bot.operator && bot.description ? " · " : ""}
								{bot.description}
							</span>
						</span>
					</label>
				))}
				{visible.length === 0 && <p className="px-3 py-4 text-center text-sm text-kumo-subtle">No crawlers match.</p>}
				{visible.length > 150 && <p className="px-3 py-2 text-center text-xs text-kumo-subtle">Showing 150 of {visible.length}. Narrow the search.</p>}
			</div>
			<form
				className="flex items-end gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					const token = custom.trim();
					if (token && isValidToken(token) && !selected.has(token.toLowerCase())) toggle(token, true);
					setCustom("");
				}}
			>
				<div className="flex-1">
					<Input
						label="Add a token that isn't listed"
						placeholder="ExampleBot"
						value={custom}
						onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCustom(e.target.value)}
					/>
				</div>
				<Button type="submit" variant="secondary" disabled={!custom.trim() || !isValidToken(custom.trim())}>
					Add
				</Button>
			</form>
		</fieldset>
	);
}

function RuleDialog(props: { rule: RobotsRule | null; bots: BotEntry[]; onClose: () => void; onDone: (rule: RobotsRule) => void }) {
	const [draft, setDraft] = React.useState<RobotsRule | null>(props.rule);
	React.useEffect(() => setDraft(props.rule), [props.rule]);
	if (!draft) return null;
	const set = (patch: Partial<RobotsRule>) => setDraft((d) => (d ? { ...d, ...patch } : d));
	const pathField = PATH_LABELS[draft.kind];
	const lines = directives(draft);
	const problem = !draft.name.trim()
		? "Give the rule a name."
		: !draft.agents.length
			? "Pick at least one crawler."
			: pathField && !draft.path?.trim()
				? `Enter the ${pathField[0].toLowerCase()}.`
				: (draft.kind === "filetype" || draft.kind === "filetype_in_folder") && !draft.ext?.trim()
					? "Enter a file extension."
					: null;

	return (
		<Dialog.Root open={props.rule !== null} onOpenChange={(open) => !open && props.onClose()}>
			<Dialog className="max-h-[90vh] overflow-y-auto p-6" size="xl">
				<Dialog.Title className="text-lg font-semibold">{draft.name ? draft.name : "New rule"}</Dialog.Title>
				<Dialog.Description className="mt-1 text-sm text-kumo-subtle">
					Each rule becomes its own group in robots.txt, with its name as a comment. Crawlers follow only the groups that name
					them, and the most specific path wins.
				</Dialog.Description>
				<form
					className="mt-4 space-y-4"
					onSubmit={(e) => {
						e.preventDefault();
						if (!problem) props.onDone(draft);
					}}
				>
					<Input label="Name" value={draft.name} onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ name: e.target.value })} required />
					<Input
						label="Description (optional)"
						value={draft.description ?? ""}
						onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ description: e.target.value })}
					/>
					<div className="grid gap-3 sm:grid-cols-2">
						<Select
							label="Applies to"
							value={draft.kind}
							onValueChange={(v: string | null) => set({ kind: (v ?? "entire_site") as RuleKind })}
							items={Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label }))}
						/>
						{draft.kind !== "allow_exception" && (
							<Select
								label="Action"
								value={draft.directive}
								onValueChange={(v: string | null) => set({ directive: v === "allow" ? "allow" : "disallow" })}
								items={[
									{ value: "disallow", label: "Block (Disallow)" },
									{ value: "allow", label: "Allow" },
								]}
							/>
						)}
					</div>
					{pathField && (
						<Input
							label={pathField[0]}
							placeholder={pathField[1]}
							value={draft.path ?? ""}
							onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ path: e.target.value })}
						/>
					)}
					{(draft.kind === "filetype" || draft.kind === "filetype_in_folder") && (
						<Input label="File extension" placeholder="pdf" value={draft.ext ?? ""} onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ ext: e.target.value })} />
					)}
					{draft.kind === "allow_exception" && (
						<Input
							label="Item to allow inside it"
							placeholder="/members/welcome/"
							value={draft.allow ?? ""}
							onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ allow: e.target.value })}
						/>
					)}
					{draft.kind === "single_page" && (
						<Checkbox
							label="Strict: match this path only, not longer paths that start with it"
							checked={draft.strict ?? false}
							onCheckedChange={(on: boolean) => set({ strict: on })}
						/>
					)}
					<div className="rounded bg-kumo-tint/50 px-3 py-2">
						<p className="text-xs text-kumo-subtle">Writes</p>
						<pre className="font-mono text-xs">{lines.map((l) => `${l.directive}: ${l.value}`).join("\n")}</pre>
					</div>
					<BotPicker bots={props.bots} selected={draft.agents} onChange={(agents) => set({ agents })} />
					{problem && <p className="text-sm text-kumo-subtle">{problem}</p>}
					<div className="flex justify-end gap-2">
						<Button type="button" variant="secondary" onClick={props.onClose}>
							Cancel
						</Button>
						<Button type="submit" variant="primary" disabled={Boolean(problem)}>
							Done
						</Button>
					</div>
				</form>
			</Dialog>
		</Dialog.Root>
	);
}

function Tester(props: { robotsTxt: string; bots: BotEntry[]; siteUrl: string }) {
	const [agent, setAgent] = React.useState("GPTBot");
	const [url, setUrl] = React.useState("/");
	const tokens = React.useMemo(() => [...new Set(props.bots.map((b) => b.token))].sort((a, b) => a.localeCompare(b)), [props.bots]);
	const token = agent.trim();
	const verdict = token && url.trim() ? evaluate(props.robotsTxt, [token], url.trim()) : null;
	const lines = props.robotsTxt.split("\n");

	return (
		<section className="space-y-3 rounded-lg border p-4" aria-labelledby="robots-tester">
			<h2 id="robots-tester" className="text-base font-semibold">
				Can a crawler fetch a URL?
			</h2>
			<p className="text-sm text-kumo-subtle">
				Tests the robots.txt above (including unsaved changes) the way Googlebot reads it: the crawler's own groups, else{" "}
				<code>*</code>; longest match wins; Allow wins ties.
			</p>
			<div className="flex flex-col gap-2 sm:flex-row sm:items-end">
				<div className="sm:w-56">
					<Input label="Crawler token" list="cw-robots-tokens" value={agent} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAgent(e.target.value)} />
					<datalist id="cw-robots-tokens">
						{tokens.map((t) => (
							<option key={t} value={t} />
						))}
					</datalist>
				</div>
				<div className="flex-1">
					<Input
						label="URL or path"
						placeholder={`${props.siteUrl || "https://example.com"}/some/page/`}
						value={url}
						onChange={(e: React.ChangeEvent<HTMLInputElement>) => setUrl(e.target.value)}
					/>
				</div>
			</div>
			<div aria-live="polite" className="text-sm">
				{verdict && (
					<p className="flex items-start gap-2">
						{verdict.allowed ? (
							<CheckCircle className="mt-0.5 shrink-0 text-kumo-success" aria-hidden="true" />
						) : (
							<XCircle className="mt-0.5 shrink-0 text-kumo-danger" aria-hidden="true" />
						)}
						<span>
							<strong>{verdict.allowed ? "Allowed" : "Blocked"}</strong> for <code>{token}</code> at <code>{verdict.path}</code>.{" "}
							{verdict.matchedDirective === "none"
								? verdict.scope === "specific"
									? `${token} has its own group(s) and none of their rules match, so it may fetch it.`
									: "No rule matches, so it may fetch it."
								: `Decided by line ${verdict.matchedLine}: ${lines[verdict.matchedLine - 1]?.trim()} (${verdict.scope === "specific" ? `${token}'s own group` : "the * group"}).`}
						</span>
					</p>
				)}
			</div>
		</section>
	);
}

export function RobotsPage() {
	const [data, setData] = React.useState<PageData>();
	const [config, setConfig] = React.useState<RobotsConfig>();
	const [bots, setBots] = React.useState<BotEntry[]>([]);
	const [error, setError] = React.useState<string>();
	const [notice, setNotice] = React.useState<string>();
	const [editing, setEditing] = React.useState<{ rule: RobotsRule; index: number } | null>(null);
	const [saving, setSaving] = React.useState(false);
	const [dirty, setDirty] = React.useState(false);
	const [syncing, setSyncing] = React.useState(false);

	const load = React.useCallback(async () => {
		setError(undefined);
		try {
			const [page, directory] = await Promise.all([
				parseApiResponse<PageData>(await apiFetch(`${API}/get`), "Could not load robots.txt rules"),
				parseApiResponse<{ bots: BotEntry[] }>(await apiFetch(`${API}/bots`), "Could not load the crawler directory"),
			]);
			setData(page);
			setConfig(page.config);
			setBots(directory.bots);
			setDirty(false);
		} catch (cause) {
			setError(errorText(cause, "Could not load robots.txt rules"));
		}
	}, []);
	React.useEffect(() => {
		void load();
	}, [load]);

	const update = (patch: Partial<RobotsConfig>) => {
		setConfig((c) => (c ? { ...c, ...patch } : c));
		setDirty(true);
		setNotice(undefined);
	};
	const setRules = (rules: RobotsRule[]) => update({ rules });

	const preview = React.useMemo(() => (config && data ? generate(config, { siteUrl: data.siteUrl }) : ""), [config, data]);

	const save = async () => {
		if (!config) return;
		setSaving(true);
		setError(undefined);
		try {
			const result = await post<{ config: RobotsConfig }>("save", config);
			setConfig(result.config);
			setData((d) => (d ? { ...d, saved: true } : d));
			setDirty(false);
			setNotice("Saved. /robots.txt now serves these rules (other Worker instances pick them up within a minute).");
		} catch (cause) {
			setError(errorText(cause, "Could not save"));
		} finally {
			setSaving(false);
		}
	};

	const refresh = async () => {
		setSyncing(true);
		setError(undefined);
		try {
			const state = await post<SyncState>("refresh", {});
			if (!state.ok) throw new Error(state.error ?? "Radar sync failed");
			setNotice(`Crawler list refreshed from Cloudflare Radar: ${state.total} bots, ${state.added} new, ${state.updated} updated.`);
			await load();
		} catch (cause) {
			const message = errorText(cause, "Radar sync failed");
			setError(/turned off/i.test(message) ? "Turn on “Weekly crawler list from Cloudflare Radar” under Coywolf Pack → Features first." : message);
		} finally {
			setSyncing(false);
		}
	};

	const addFromPreset = (preset?: Omit<RobotsRule, "id" | "enabled">) =>
		setEditing({
			rule: preset
				? { ...preset, agents: [...preset.agents], id: newId(), enabled: true }
				: { id: newId(), name: "", enabled: true, agents: ["*"], directive: "disallow", kind: "folder", path: "" },
			index: -1,
		});

	const move = (index: number, by: number) => {
		if (!config) return;
		const rules = [...config.rules];
		const [rule] = rules.splice(index, 1);
		rules.splice(index + by, 0, rule);
		setRules(rules);
	};

	const bySlugToken = React.useMemo(() => tokenIndex(bots), [bots]);
	const unverifiedCount = bots.filter((b) => b.status === "unverified").length;

	if (!data || !config) {
		return error ? <Banner variant="error" role="alert" title="Something went wrong" description={error} /> : (
			<div className="py-12 text-center text-kumo-subtle">
				<Loader />
			</div>
		);
	}

	return (
		<div className="space-y-6">
			<header className="grid min-w-0 gap-4 border-b border-kumo-line pb-4">
				<div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1">
					<h1 className="flex min-h-9 min-w-0 items-center text-2xl font-semibold leading-tight">Robots.txt</h1>
					<div className="flex shrink-0 justify-end gap-2">
						<DropdownMenu>
							<DropdownMenu.Trigger render={<Button variant="secondary" icon={<Plus />}>New rule</Button>} />
							<DropdownMenu.Content className="p-1">
								{data.presets.map((preset) => (
									<DropdownMenu.Item key={preset.name} className="py-1 data-highlighted:bg-kumo-fill" onClick={() => addFromPreset(preset)}>
										{preset.name}
									</DropdownMenu.Item>
								))}
								<DropdownMenu.Separator className="my-0.5" />
								<DropdownMenu.Item className="py-1 data-highlighted:bg-kumo-fill" onClick={() => addFromPreset()}>
									Custom path rule
								</DropdownMenu.Item>
							</DropdownMenu.Content>
						</DropdownMenu>
						<Button variant="primary" disabled={saving || (!dirty && data.saved)} onClick={() => void save()}>
							{saving ? "Saving…" : data.saved ? "Save" : "Save and serve"}
						</Button>
					</div>
					<p className="col-span-2 text-sm leading-5 text-pretty text-kumo-subtle">
						Write robots.txt as named rules. EmDash's own lines stay in: its admin and API are blocked for every crawler, media
						files stay crawlable, and the sitemap is listed. Turn this feature off to go back to EmDash's robots.txt.
					</p>
				</div>
			</header>

			<div aria-live="polite">
				{notice && <Banner variant="default" role="status" title={notice} />}
				{dirty && !notice && <p className="text-sm text-kumo-subtle">Unsaved changes.</p>}
			</div>
			{error && <Banner variant="error" role="alert" title="Something went wrong" description={error} />}
			{!data.saved && (
				<Banner
					variant="default"
					title="Not serving yet"
					description="EmDash's robots.txt is served until you save rules here."
				/>
			)}
			{data.emdashRobotsTxt && (
				<Banner
					variant="alert"
					title="EmDash has its own custom robots.txt"
					description={
						<span>
							Saved rules here replace it while this feature is on.{" "}
							<button
								type="button"
								className="underline"
								onClick={() =>
									update({
										extra: [config.extra.trim(), (data.emdashRobotsTxt ?? "").split("\n").filter((l) => !/^\s*sitemap\s*:/i.test(l)).join("\n").trim()]
											.filter(Boolean)
											.join("\n\n"),
									})
								}
							>
								Copy its lines into Extra lines
							</button>
						</span>
					}
				/>
			)}

			<section className="space-y-2" aria-labelledby="robots-rules">
				<h2 id="robots-rules" className="text-base font-semibold">
					Rules
				</h2>
				{config.rules.length === 0 ? (
					<div className="rounded-lg border py-10 text-center text-kumo-subtle">
						<Robot size={40} className="mx-auto mb-3 opacity-30" aria-hidden="true" />
						<p className="text-base font-medium">No rules yet</p>
						<p className="mt-1 text-sm">Every crawler may fetch everything except EmDash's admin. Add a rule to change that.</p>
					</div>
				) : (
					<div className="rounded-lg border">
						{config.rules.map((rule, index) => (
							<div key={rule.id} className={`flex items-start gap-3 border-b px-4 py-3 text-sm last:border-0 ${rule.enabled ? "" : "opacity-60"}`}>
								<Switch
									size="sm"
									aria-label={`${rule.name}: ${rule.enabled ? "on" : "off"}`}
									checked={rule.enabled}
									onCheckedChange={(on) => setRules(config.rules.map((r, i) => (i === index ? { ...r, enabled: on } : r)))}
								/>
								<div className="min-w-0 flex-1">
									<div className="font-medium">{rule.name}</div>
									{rule.description && <div className="text-xs text-kumo-subtle">{rule.description}</div>}
									<div className="mt-1 flex flex-wrap gap-1">
										{rule.agents.slice(0, 8).map((a) => {
											const bot = bySlugToken.get(a.toLowerCase());
											return (
												<Badge key={a} variant={bot?.status === "unverified" ? "warning" : "secondary"}>
													{a === "*" ? "all crawlers" : a}
												</Badge>
											);
										})}
										{rule.agents.length > 8 && <Badge variant="outline">+{rule.agents.length - 8} more</Badge>}
									</div>
									<code className="mt-1 block text-xs text-kumo-subtle">
										{directives(rule)
											.map((d) => `${d.directive}: ${d.value}`)
											.join(" · ")}
									</code>
								</div>
								<DropdownMenu>
									<DropdownMenu.Trigger
										render={<Button type="button" variant="ghost" shape="square" icon={<DotsThree aria-hidden="true" />} aria-label={`Actions for ${rule.name}`} />}
									/>
									<DropdownMenu.Content className="p-1">
										<DropdownMenu.Item className="py-1 data-highlighted:bg-kumo-fill" icon={<PencilSimple className="me-1.5 size-3.5" aria-hidden="true" />} onClick={() => setEditing({ rule, index })}>
											Edit
										</DropdownMenu.Item>
										{index > 0 && (
											<DropdownMenu.Item className="py-1 data-highlighted:bg-kumo-fill" icon={<ArrowUp className="me-1.5 size-3.5" aria-hidden="true" />} onClick={() => move(index, -1)}>
												Move up
											</DropdownMenu.Item>
										)}
										{index < config.rules.length - 1 && (
											<DropdownMenu.Item className="py-1 data-highlighted:bg-kumo-fill" icon={<ArrowDown className="me-1.5 size-3.5" aria-hidden="true" />} onClick={() => move(index, 1)}>
												Move down
											</DropdownMenu.Item>
										)}
										<DropdownMenu.Separator className="my-0.5" />
										<DropdownMenu.Item
											className="py-1 data-highlighted:bg-kumo-fill"
											icon={<Trash className="me-1.5 size-3.5" aria-hidden="true" />}
											onClick={() => window.confirm(`Delete “${rule.name}”?`) && setRules(config.rules.filter((_, i) => i !== index))}
										>
											Delete
										</DropdownMenu.Item>
									</DropdownMenu.Content>
								</DropdownMenu>
							</div>
						))}
					</div>
				)}
			</section>

			<section className="space-y-3" aria-labelledby="robots-options">
				<h2 id="robots-options" className="text-base font-semibold">
					Sitemaps and extras
				</h2>
				<Checkbox
					label={`List EmDash's sitemap (${data.siteUrl || "your site"}/sitemap.xml)`}
					checked={config.includeSitemap}
					onCheckedChange={(on: boolean) => update({ includeSitemap: on })}
				/>
				<Checkbox
					label="Keep media crawlable (Allow: /_emdash/api/media/, so images appear in image search)"
					checked={config.allowMedia}
					onCheckedChange={(on: boolean) => update({ allowMedia: on })}
				/>
				<Checkbox label="Write rule names as comments" checked={config.comments} onCheckedChange={(on: boolean) => update({ comments: on })} />
				<InputArea
					label="More sitemaps (one URL or path per line)"
					rows={3}
					value={config.sitemaps.join("\n")}
					onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => update({ sitemaps: e.target.value.split("\n") })}
					className="font-mono text-xs"
				/>
				<InputArea
					label="Extra lines (added as written, e.g. Content-Signal or Crawl-delay)"
					rows={4}
					value={config.extra}
					onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => update({ extra: e.target.value })}
					className="font-mono text-xs"
				/>
			</section>

			<section className="space-y-2" aria-labelledby="robots-preview">
				<h2 id="robots-preview" className="text-base font-semibold">
					Preview
				</h2>
				<pre className="max-h-96 overflow-auto rounded-lg border bg-kumo-tint/40 p-3 font-mono text-xs">{preview}</pre>
			</section>

			<Tester robotsTxt={preview} bots={bots} siteUrl={data.siteUrl} />

			<section className="space-y-2 rounded-lg border p-4" aria-labelledby="robots-directory">
				<div className="flex flex-wrap items-start justify-between gap-2">
					<h2 id="robots-directory" className="text-base font-semibold">
						Crawler directory
					</h2>
					<Button variant="secondary" icon={<ArrowsClockwise />} disabled={syncing || !data.radar.tokenConfigured} onClick={() => void refresh()}>
						{syncing ? "Refreshing…" : "Refresh from Radar"}
					</Button>
				</div>
				<p className="text-sm text-kumo-subtle">
					{bots.length} crawlers from Cloudflare Radar's bot directory and operators' documentation (bundled list from{" "}
					{dateFormat.format(new Date(`${data.radar.baselineDate}T12:00:00Z`))}). {unverifiedCount} have a{" "}
					<Badge variant="warning">unverified</Badge> token that the operator doesn't document; they still work as robots.txt tokens
					if the crawler uses them.
				</p>
				<p className="text-sm text-kumo-subtle" aria-live="polite">
					{!data.radar.tokenConfigured
						? "To refresh the list weekly, add a Cloudflare Radar API token (Account → Radar → Read) in the plugin settings and turn on “Weekly crawler list from Cloudflare Radar” under Features."
						: data.radar.state
							? data.radar.state.ok
								? `Last Radar sync ${dateFormat.format(new Date(data.radar.state.at))}: ${data.radar.state.total} bots, ${data.radar.state.added} new.`
								: `Last Radar sync failed ${dateFormat.format(new Date(data.radar.state.at))}: ${data.radar.state.error}`
							: "Radar token set; no sync has run yet."}
				</p>
			</section>

			<RuleDialog
				rule={editing?.rule ?? null}
				bots={bots}
				onClose={() => setEditing(null)}
				onDone={(rule) => {
					const index = editing?.index ?? -1;
					setRules(index >= 0 ? config.rules.map((r, i) => (i === index ? rule : r)) : [...config.rules, rule]);
					setEditing(null);
				}}
			/>
		</div>
	);
}
