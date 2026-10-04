/**
 * Step-by-step guides for getting the API keys and tokens some features need,
 * shown next to each credential field in a native <details> (closed until
 * opened). EmDash's generic Settings page only takes plain-text descriptions,
 * so its fields carry a short version and point here (src/core/secrets.ts).
 */
import * as React from "react";

export type GuideId = "anthropic" | "openai" | "gemini" | "workers-ai" | "r2" | "stream" | "radar";

function Link(props: { href: string; children: React.ReactNode }) {
	return (
		<a href={props.href} target="_blank" rel="noreferrer" className="text-kumo-link underline">
			{props.children}
		</a>
	);
}

const C = (props: { children: React.ReactNode }) => <code className="rounded bg-kumo-tint px-1 text-xs">{props.children}</code>;
const B = (props: { children: React.ReactNode }) => <strong className="font-medium">{props.children}</strong>;

/** Creating a Cloudflare API token: the steps every token guide shares. */
function CloudflareTokenSteps(props: { permission: React.ReactNode }) {
	return (
		<>
			<li>
				Sign in to the <Link href="https://dash.cloudflare.com/profile/api-tokens">Cloudflare dashboard → My Profile → API Tokens</Link>.
			</li>
			<li>
				Select <B>Create Token</B>, then <B>Create Custom Token → Get started</B>.
			</li>
			<li>Name it after this site so you'll recognize it later.</li>
			<li>Under Permissions, choose {props.permission}.</li>
			<li>
				Under Account Resources, choose <B>Include → your account</B>.
			</li>
			<li>
				Select <B>Continue to summary</B>, then <B>Create Token</B>.
			</li>
			<li>Copy the token right away. Cloudflare shows it only once.</li>
		</>
	);
}

const GUIDES: Record<GuideId, { summary: string; steps: React.ReactNode; note?: React.ReactNode }> = {
	anthropic: {
		summary: "How to get an Anthropic API key",
		steps: (
			<>
				<li>
					Sign in to the <Link href="https://platform.claude.com/settings/keys">Claude Console</Link> (create an account if you don't have one).
				</li>
				<li>
					Add a payment method or credits under <B>Billing</B>. Keys don't work without them.
				</li>
				<li>
					Go to <B>API Keys</B> and select <B>Create Key</B>. Name it after this site.
				</li>
				<li>Copy the key (it starts with sk-ant-). It's shown only once.</li>
				<li>Paste it into the API key field and save.</li>
			</>
		),
		note: "Each analyzed entry or image is one model call, billed by Anthropic. The daily call limit caps what you spend.",
	},
	openai: {
		summary: "How to get an OpenAI API key",
		steps: (
			<>
				<li>
					Sign in to the <Link href="https://platform.openai.com/api-keys">OpenAI Platform → API keys</Link>.
				</li>
				<li>
					Add a payment method or credits under <B>Settings → Billing</B>. Keys don't work without them.
				</li>
				<li>
					Select <B>Create new secret key</B>, name it after this site, and keep the default permissions.
				</li>
				<li>Copy the key (it starts with sk-). It's shown only once.</li>
				<li>Paste it into the API key field and save.</li>
			</>
		),
		note: "Each analyzed entry or image is one model call, billed by OpenAI. The daily call limit caps what you spend.",
	},
	gemini: {
		summary: "How to get a Google Gemini API key",
		steps: (
			<>
				<li>
					Sign in to <Link href="https://aistudio.google.com/apikey">Google AI Studio → API keys</Link> with a Google account.
				</li>
				<li>
					Select <B>Create API key</B> and pick (or create) a Google Cloud project.
				</li>
				<li>Copy the key.</li>
				<li>Paste it into the API key field and save.</li>
			</>
		),
		note: "The free tier has low rate limits. For steady use, turn on billing for the project in Google AI Studio.",
	},
	"workers-ai": {
		summary: "How to connect Workers AI (no key needed)",
		steps: (
			<>
				<li>
					Open your site's <C>wrangler.jsonc</C>.
				</li>
				<li>
					Add <C>{`"ai": { "binding": "AI" }`}</C> at the top level.
				</li>
				<li>Deploy the site. This page then shows the binding as connected.</li>
			</>
		),
		note: "Workers AI is billed to your Cloudflare account, with a daily free allowance.",
	},
	r2: {
		summary: "How to get the R2 account ID and keys",
		steps: (
			<>
				<li>
					In the <Link href="https://dash.cloudflare.com/?to=/:account/r2/overview">Cloudflare dashboard → R2</Link>, copy your <B>Account ID</B> (shown on the R2 overview page) into
					R2 account ID.
				</li>
				<li>
					Under Buckets, note the name of the bucket bound as <C>MEDIA</C> in your <C>wrangler.jsonc</C>. Enter it as the R2 bucket name.
				</li>
				<li>
					Select <B>Manage API tokens</B> (on the R2 overview page), then <B>Create Account API token</B>.
				</li>
				<li>
					Choose the <B>Object Read &amp; Write</B> permission and <B>Apply to specific buckets only</B> → that bucket.
				</li>
				<li>
					Select <B>Create API Token</B>. Copy the <B>Access Key ID</B> and <B>Secret Access Key</B>. The secret is shown only once.
				</li>
				<li>Paste them into the fields here and save. The secret is stored encrypted.</li>
				<li>
					Add a CORS policy to the bucket so browsers can upload to it (see the README), then use <B>Check CORS</B> on the Files page.
				</li>
			</>
		),
	},
	stream: {
		summary: "How to get the Stream account ID and API token",
		steps: (
			<>
				<li>
					In the <Link href="https://dash.cloudflare.com/?to=/:account/stream">Cloudflare dashboard → Stream</Link>, copy your <B>Account ID</B> (in the right-hand
					column, or from the address bar after dash.cloudflare.com/) into Cloudflare account ID.
				</li>
				<CloudflareTokenSteps
					permission={
						<>
							<B>Account → Stream → Edit</B>
						</>
					}
				/>
				<li>Paste the token into Stream API token and save. It's stored encrypted.</li>
			</>
		),
		note: (
			<>
				Or set them as Worker variables instead: <C>CF_ACCOUNT_ID</C>, and the token with <C>npx wrangler secret put CF_STREAM_TOKEN</C>.
			</>
		),
	},
	radar: {
		summary: "How to get a Cloudflare Radar API token",
		steps: (
			<>
				<CloudflareTokenSteps
					permission={
						<>
							<B>Account → Radar → Read</B>
						</>
					}
				/>
				<li>Paste the token into Cloudflare Radar API token and save. It's stored encrypted.</li>
			</>
		),
		note: (
			<>
				Radar's API is free. Or set the token as a Worker secret instead: <C>npx wrangler secret put RADAR_API_TOKEN</C>.
			</>
		),
	},
};

/** A guide in a closed <details>, using the browser's own disclosure triangle. */
export function CredentialGuide({ id }: { id: GuideId }) {
	const guide = GUIDES[id];
	return (
		<details className="rounded-md border border-kumo-line text-sm">
			<summary className="cursor-pointer px-3 py-2 font-medium" style={{ display: "list-item" }}>
				{guide.summary}
			</summary>
			<div className="space-y-2 border-t border-kumo-line px-3 py-3">
				<ol className="space-y-1.5" style={{ listStyle: "decimal", paddingInlineStart: "1.25rem" }}>
					{guide.steps}
				</ol>
				{guide.note && <p className="text-xs text-kumo-subtle">{guide.note}</p>}
			</div>
		</details>
	);
}
