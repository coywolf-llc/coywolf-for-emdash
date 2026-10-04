# Coywolf Pack for EmDash

One plugin with [Coywolf](https://coywolf.com)'s features for [EmDash](https://emdashcms.com) sites on Cloudflare: the things Coywolf's WordPress plugins do that EmDash doesn't do natively. Enable only the modules you want.

| Module | What it does |
| --- | --- |
| **Backups** | Full backups (D1 database + R2 media), rewind with undo, restore to a new database, missing-media restore |
| **Redirects** | Redirect manager for what EmDash's built-in Redirects can't handle: external destinations and file paths |
| **Headings & TOC** | Linkable headings (`#jump-…` anchors), a Table of Contents block, and a Breadcrumbs block and theme component |
| **Code Blocks** | Server-side syntax highlighting, themes, language label, copy button and line numbers for code blocks |
| **File Downloads** | A download card block, stable download URLs with counts, a Files page, and direct-to-R2 uploads of any size |
| **Search** | Settings page for EmDash's full-text search, a search box with as-you-type suggestions and an OR fallback, and rate limiting |

More modules will follow as Coywolf's WordPress plugins move to EmDash.

This is a native (trusted) EmDash plugin, so it installs from GitHub or npm rather than the EmDash plugin directory. The directory lists only sandboxed plugins, which can't read the database or buckets directly.

## Requirements

EmDash 1.1+ on the Cloudflare adapter, with a D1 database (`DB`) and an R2 media bucket (`MEDIA`).

## Install

```bash
npm install https://codeload.github.com/coywolf-llc/coywolf-pack/tar.gz/refs/tags/v0.2.0
```

Use the tarball URL rather than `github:coywolf-llc/coywolf-pack`: npm records `github:` installs as SSH Git URLs, which CI runners without an SSH key can't fetch.

```js
// astro.config.mjs
import { coywolfPlugin } from "@coywolf/emdash";

emdash({
  // ...
  plugins: [
    coywolfPlugin({
      backups: { name: "mysite" },
      redirects: {},
    }),
  ],
});
```

Each module appears under **Plugins → Coywolf Pack** in the admin. Omit a module (or set it to `false`) to turn it off.

In development, keep Vite from pre-bundling the plugin. A pre-bundled copy gets its own instance of `emdash`, which breaks plugin error handling. Its UI libraries should stay pre-bundled:

```js
// astro.config.mjs
export default defineConfig({
  vite: {
    optimizeDeps: { exclude: ["@coywolf/emdash"], include: ["@phosphor-icons/react", "@cloudflare/kumo"] },
    ssr: { optimizeDeps: { exclude: ["@coywolf/emdash"] } },
  },
});
```

## Backups

- **Database**: a restorable SQL dump of the site's D1 database: users, passkeys, settings, redirects, menus, plugin data, and content. Search indexes rebuild automatically on restore.
- **Media**: a mirror of the R2 media bucket. Replaced or deleted files are kept under a dated folder until retention expires.
- **Admin**: **Back up now**, downloads, and a dashboard widget that warns when backups stop. Settings: daily scheduled backup, retention (default 30 days), staleness warning.
- **Restore** (optional, see below): **Rewind to this backup** (D1 Time Travel, with **Undo rewind**), **Restore to a new database** (import plus per-table row-count check), and **Restore missing media**.

Theme code isn't included: it lives in your Git repository.

### Setup

1. Create a backup bucket and bind it as `BACKUPS` in `wrangler.jsonc`:

   ```bash
   npx wrangler r2 bucket create mysite-backups
   ```

   ```jsonc
   "r2_buckets": [
     { "binding": "MEDIA", "bucket_name": "mysite-media" },
     { "binding": "BACKUPS", "bucket_name": "mysite-backups" }
   ]
   ```

2. Options: `database` (default `"DB"`), `media` (`"MEDIA"`), `backups` (`"BACKUPS"`), `name` (dump file prefix, default `"database"`).

### Enable restore

Restores use the Cloudflare API, because a Worker can't create databases or time-travel through its D1 binding.

1. Create an API token with one permission, **Account → D1 → Edit**.
2. Store it as a Worker secret. It isn't a plugin setting, because a rewind rolls plugin settings back too:

   ```bash
   npx wrangler secret put BACKUPS_API_TOKEN
   ```

3. Add the IDs and deploy:

   ```js
   coywolfPlugin({
     backups: { name: "mysite", restore: { accountId: "<account id>", databaseId: "<D1 database id>" } },
   });
   ```

Rewinds save an undo point to the backup bucket first; undo steps back one rewind at a time.

### Backup layout

```text
d1/<stamp>/<name>.sql.gz         database dump
d1/<stamp>/manifest.json         stamp, size, SHA-256, source, row counts, Time Travel bookmark
media/current/<key>              mirror of the media bucket
media/changed/<stamp>/<key>      media replaced or deleted at that backup
restore/undo/<time>.json         undo points for rewinds
```

External jobs (a nightly GitHub Action, for example) can write to the same layout, and the admin lists those backups too.

### Manual restore

Restore into a **new, empty** D1 database and switch the `DB` binding to it. Never import over the live database:

```bash
npx wrangler d1 create mysite-restore
gunzip -c mysite.sql.gz > restore.sql
npx wrangler d1 execute mysite-restore --remote --file restore.sql
```

Keep `EMDASH_ENCRYPTION_KEY` in a password manager. It isn't in backups, and encrypted plugin settings can't be read without it.

### Notes

- `wrangler d1 export` refuses databases with FTS5 tables (EmDash search). The dump writes tables, then search tables and their triggers, then rows with parent tables before child tables (D1 imports large files in batches, so deferred foreign keys aren't enough), then indexes and the remaining triggers.
- Backups run in one Worker request, so they suit small and medium sites. The database is saved before the media mirror runs. The mirror copies at most 300 changed files per run; the rest follow on the next run.
- Integers larger than 2^53 lose precision (D1 returns JavaScript numbers). EmDash stores IDs as text.

## Redirects

EmDash's built-in Redirects (**Manage → Redirects**) handle site-relative page redirects. This module covers what they can't:

- **External destinations**, such as affiliate links (`/visit/partner`) and articles that moved to another site.
- **File paths**, such as old WordPress `/wp-content/uploads/` image URLs. EmDash's middleware skips any path with a file extension.

Features: exact paths (with or without a trailing slash) or regular expressions with `$1`–`$9` substitution, 301/302/307/308/410, enable/disable, notes, hit counts, a URL tester, and bulk import (JSON, or tab/comma-separated `source, target, type, is_regex` rows; a Coywolf SEO export from WordPress works as is). Rules are stored in the site's D1 database (`coywolf_redirects`), so backups include them.

### Setup

Add the middleware to `src/middleware.ts`:

```ts
import { sequence } from "astro:middleware";
import { coywolfRedirects } from "@coywolf/emdash/middleware";

export const onRequest = sequence(coywolfRedirects(), /* your middleware */);
```

Rules are read at most once a minute per Worker isolate, and hits are counted after the response is sent, so redirects add no database query to normal page views.

### Removed content

Feature **Redirects → Removed content** (`redirects.trashPrompt`, off by default). When a published entry is deleted (trashed) or unpublished, its old URL is listed in a **Removed content** panel on the Redirects page, with three choices:

- **Redirect to…** creates a Coywolf redirect rule (301 by default) from the old URL.
- **Return 410 Gone** creates a 410 rule, telling search engines the page is gone for good.
- **Dismiss** forgets it (for example, when the URL should simply 404).

The old URL is resolved the way EmDash resolves it: the collection's URL pattern (`{slug}`, `{id}`, and date tokens from the publish date), or `/<collection>/<slug>`. Locale prefixes aren't added. Drafts that were never published aren't listed, and republishing an entry, or restoring it from the trash (it comes back as a draft), removes it from the list. Decisions are kept in plugin storage (`redirects_removed`). The module declares the `content:read` capability for the delete and publish hooks.

### Export redirects from WordPress (Coywolf SEO)

```bash
wp db query "SELECT source, target, type, is_regex FROM wp_coywolf_seo_redirects"
```

Paste the output into **Redirects → Import**.

## Headings & TOC

Ported from Coywolf SEO. Off until you turn it on under **Features**:

| Feature | Default | What it does |
| --- | --- | --- |
| `headings` | off | Main switch |
| `headings.anchors` | off | Every H2–H6 gets an id like `jump-pricing`, plus an optional "copy link to section" button on hover and focus |
| `headings.toc` | off | **Table of Contents** block: title, heading levels, plain/bulleted/numbered (1, 1.1, 1.1.1), always open or collapsible (open or collapsed) |
| `headings.breadcrumbs` | off | **Breadcrumbs** block and a `Breadcrumbs` component for themes |

Site defaults live on **Headings & TOC**: id prefix, copy link, scroll offset for sticky headers (px or rem), TOC defaults (title, levels, style, display, minimum headings, smooth scrolling), and breadcrumb separator, home label, and whether to show home and the current page.

Anchors are written into the content when it's saved (an `anchor` field on each heading block), so they're unique within the entry and stay the same when a heading is reworded. A Table of Contents block stores the entry's heading list the same way, so the table always matches the anchors. After turning the features on, re-save an entry to stamp it; until then headings get ids from their text when the page renders.

### Setup

EmDash lets plugins add block types but not change how headings render, so the theme passes the pack's heading renderer to `PortableText` (one line, wherever content is rendered):

```astro
---
import { PortableText } from "emdash/ui";
import { portableTextComponents } from "@coywolf/emdash/astro";
---
<PortableText value={entry.data.content} components={portableTextComponents} />
```

If you already pass components, merge them: `components={{ ...portableTextComponents, type: myTypes }}`. With the anchors and TOC features off, headings render exactly as before.

For breadcrumbs in a layout instead of a block:

```astro
---
import { Breadcrumbs } from "@coywolf/emdash/astro";
---
<Breadcrumbs page={page} />
```

Props: `page` (the `PublicPageContext` you pass to `EmDashHead`), `items` (`{ name, url }[]`), `title`, `separator` (`slash`, `chevron`, `guillemet`, `bullet`, `arrow`, `gt`, or any short string), `homeLabel`, `showHome`, `showCurrent`, `class`, `label`.

The trail comes from, in order: `items`, `page.breadcrumbs`, the trail the theme gave `EmDashHead` for the same URL (picked up by the pack's `page:metadata` hook, so the Breadcrumbs block uses it too), or the URL path (home, one crumb per path segment with a readable name, then the page title). Give themes with archives or nested content a real trail through `page.breadcrumbs`: derived ancestor links point at whatever the path segments are, which may not be pages.

### Notes

- Output is server-rendered. Collapsing uses `<details>`, smooth scrolling is CSS (and is skipped for visitors who prefer reduced motion), and the only script is a small inline one for the copy-link button, sent only when that option is on.
- Markup follows Coywolf SEO's accessibility rules: the TOC is a labeled `<nav>` (its title is never a heading inside `<summary>`), breadcrumbs use `<nav aria-label="Breadcrumb">` with an `<ol>` and `aria-current="page"`, and separators are CSS that screen readers skip.
- The module declares the `content:write` capability (EmDash only registers a `content:beforeSave` hook for plugins that have it; the hook changes nothing but heading anchors and the two blocks' stored data) and `content:read`. Anchors are kept across edits by matching block keys (then heading text) against the stored entry. When an entry has unpublished draft revisions, anchors of headings added in an earlier draft are matched by text.
- Styles use `cw-` classes and the theme's colors, in light and dark mode.
- With the features off, markup is unchanged, but the components' small global stylesheet (`cw-` classes only) is still bundled on pages that import them.
- The Breadcrumbs block picks up the theme's trail only when the theme renders `<EmDashHead page={page} />` with the page's real `url`; it's matched by path and query string, so locales and variants don't mix.
## File Downloads

The Coywolf Files plugin for WordPress, on EmDash. Add a **File download** block to any entry and visitors get a download card: a colored file-type badge, the file name, a "PDF · 2.4 MB · Uploaded Mar 4, 2026" line, a Download button, and a Copy link button.

- **Block**: pick a file from the Media Library or from large uploads, then give it a title and description for that placement. Toggles show or hide the icon, description, meta line, Download, and Copy link. The card is server-rendered, scoped (`cw-file`), follows light/dark (or a fixed scheme), and ships one small script for Copy link (clipboard, checkmark, screen-reader announcement).
- **Download URLs**: `/download/<id>/<file name>`, served by the pack middleware. Files stream from R2 with `Content-Disposition: attachment`, the right `Content-Type`, `Content-Length`, `ETag`, conditional requests, and single byte ranges with `If-Range` (resumable downloads; a request for several ranges gets the whole file). Or set a public bucket / CDN URL and downloads redirect there.
- **Files page** (**Plugins → Files**): every file used in a File download block plus every large upload, with type, size, upload date, downloads, and the entries that use it. Search, In use / Unused filters, copy link, and delete. Deleting a large upload removes the object from R2; the page lists the entries that still use it (their blocks then render nothing). Media Library files are deleted in the Media Library.
- **Large uploads**: files of any type and size (EmDash's own uploads stop at 50 MB and images, video, audio, and PDF) go straight from the browser to R2 in 8 MB+ parts, four at a time, with progress, retries, and Cancel. The Worker only signs URLs (AWS Signature V4 with Web Crypto, no AWS SDK).

### Feature switches

| Feature | Default | What it does |
| --- | --- | --- |
| `files` | off | The block, download URLs, and the Files page |
| `files.counts` | off | Count downloads (batched D1 writes after the response) |
| `files.largeUploads` | off | Direct-to-R2 uploads (needs the settings below and a CORS rule) |

### Setup

1. Turn on **File Downloads** under **Plugins → Features**. The middleware from the Redirects setup (`coywolfPack()`) serves the download URLs; nothing else to add.
2. Settings (the Coywolf Pack plugin settings): download URL base (default `download`), optional public bucket / CDN URL, card color scheme, accent color, and largest upload (default 5 GB).
3. Bindings: `DB` and `MEDIA`. To keep large uploads in their own bucket, bind it as `FILES` (or pass `files: { uploads: "MYBINDING" }`, and note the middleware looks for `FILES`).

### Large uploads

1. Create an R2 API token (**R2 → Manage API tokens**) with **Object Read & Write** on the bucket. Enter the account ID, access key ID, secret access key (stored encrypted), and bucket name in the settings. The bucket must be the one bound as `MEDIA` (or `FILES`), since downloads stream through that binding.
2. Add a CORS policy to the bucket (**R2 → bucket → Settings → CORS Policy**):

   ```json
   [{ "AllowedOrigins": ["https://example.com"], "AllowedMethods": ["PUT"], "AllowedHeaders": ["*"], "ExposeHeaders": ["ETag"], "MaxAgeSeconds": 3600 }]
   ```

3. Add a lifecycle rule to the bucket (**R2 → bucket → Settings → Object lifecycle rules**): **Abort incomplete multipart uploads after 1 day**. The pack also aborts uploads left unfinished for 24 hours in a daily task, but the rule catches anything the task can't reach (for example after the credentials change).
4. On the Files page, **Check CORS** reads the policy through the S3 API and says what's missing. Then **Upload large file**.

Only administrators (`plugins:manage`) can upload, and uploads above the **largest upload** setting (default 5 GB) are refused. R2 storage and operations are billed to your Cloudflare account.

Files are stored as `files/<id>/<name>` with their metadata in plugin storage. The pack calls only `<account>.r2.cloudflarestorage.com`.

### Notes

- Which entries use which file comes from an index updated on every save and delete. **Rebuild usage** rescans all content (needed once if blocks existed while the module was off). Entries moved to the trash stop counting as uses.
- Download counts are kept per isolate for a second and written together, so a burst of downloads costs one D1 batch. Counts made just before an isolate is evicted can be lost. A HEAD request, a 304, or a later range chunk isn't counted.
- Any ready Media Library item can be downloaded through `/download/<its id>/…`, whether or not a block uses it. That's the same exposure as EmDash's own `/_emdash/api/media/file/<key>` URLs: media files are public to anyone with the link.
- Lookups are cached per Worker isolate for 60 seconds, including "not found". A file requested just before its upload finished can keep answering 404 on that isolate for up to a minute.
- With a public bucket / CDN URL, downloads redirect to it, so the file name comes from the object key and the CDN decides the headers.

## Code Blocks

A port of Coywolf Code Block Enhancer. It replaces the site renderer for EmDash's built-in code block (the editor's language picker is unchanged) with one that highlights code **on the server** using highlight.js grammars (via lowlight, which EmDash already ships). Visitors download no highlighting script.

- **Themes** (**Plugins → Code Blocks**, with a live preview): Coywolf Auto (light/dark by system), Coywolf Always light, Coywolf Always dark, four light/dark pairs that follow the system setting (GitHub, Atom One, A11y, Tokyo Night), and 19 popular highlight.js themes (GitHub, GitHub Dark, Monokai, Nord, Dracula, Solarized, Visual Studio, Xcode, Night Owl and more). The theme is the `codeBlocksTheme` setting.
- **Language label**, **Copy button** and **Line numbers** are sub-features. The copy button follows the WordPress plugin's accessible pattern: a labeled button, a polite live region that announces "Copied to clipboard", a two-second confirmation, and no animation for visitors who prefer reduced motion. Line numbers are drawn with CSS, so they're never selected or copied. A block's `filename`, if set, is shown in its header.
- **Page weight**: the layout CSS (about 2 KB), the active theme's CSS (1–4 KB) and, with the copy button on, one small inline script (under 1 KB) are inlined once per page by the first code block. Pages without code blocks get nothing, and no external requests are made.

Feature switches: `codeBlocks` (main), `codeBlocks.label`, `codeBlocks.copy`, `codeBlocks.lineNumbers`, all off by default. While `codeBlocks` is off, code blocks render exactly as EmDash's built-in renderer does.

### Setup

Nothing beyond the plugin itself: the block renderer is registered through the plugin's `componentsEntry`, so it applies wherever the site renders Portable Text with EmDash's `<PortableText>`. It reads the theme and switches from the site's D1 database (`DB`), cached for 30 seconds per Worker isolate.

### Notes

- Languages: EmDash's editor list (Astro, Svelte and Vue are highlighted as HTML, MDX as Markdown, TOML as INI) plus highlight.js's common grammars. Unknown languages, blocks over 30,000 characters and blocks with any line over 2,000 characters are shown as plain text (highlight.js slows sharply on long lines). Rendered blocks are cached in memory (200 per Worker isolate), so repeat page views don't re-highlight.
- Theme CSS is generated from highlight.js's own stylesheets (BSD-3-Clause, each theme's original credits kept) by `node scripts/gen-code-themes.mjs`.
- Tests: `node --test src/codeBlocks/render.test.ts`.

## Schema & Social

The structured data and social tags from Coywolf SEO for WordPress, configured on **Plugins → Schema**. Everything is off until you turn it on under **Features → Schema & Social**:

| Feature | What it does |
| --- | --- |
| `schema` | The module's main switch. |
| `schema.graph` | One JSON-LD `@graph` per page in place of EmDash's built-in JSON-LD (it uses the same `primary` id, so EmDash's is replaced, not duplicated): WebSite (with a SearchAction), the publisher Organization or Person, a typed WebPage, the primary ImageObject (with dimensions and alt), author Person nodes, and a typed Article. It keeps everything EmDash's own JSON-LD has: headline, description, image, dates, author and publisher. |
| `schema.breadcrumbs` | A BreadcrumbList. Uses the theme's `breadcrumbs` from the page context when it passes them (`[]` means none), otherwise it's derived from the URL path (parent segments, then the page title). **If your theme prints its own BreadcrumbList, remove it when you turn this on**, or pages will have two. |
| `schema.robots` | A robots meta tag: `index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1` by default, merged with each entry's **No index** (which stays `noindex, nofollow`). |
| `schema.openGraph` | `og:locale`, plus `og:image:width`, `og:image:height`, `og:image:type`, `og:image:alt` and `twitter:image:alt` when the image is from the media library. |
| `schema.authors` | Schema.org Person properties per byline (job title, sameAs profiles, image, description…), used as article authors. |

The Schema page has:

- **Site details**: whether the publisher is an Organization or a Person (a byline), and the publisher's properties, picked from the same property list as on WordPress (name, legalName, url, logo, sameAs, address, contactPoint, founder, and so on; logo and image can come from the media library). Anything left empty falls back to EmDash's site title, URL and logo.
- **Types**: the WebPage subtype (AboutPage, ContactPage, CollectionPage…) and Article subtype (BlogPosting, NewsArticle, TechArticle… or none) for the home page, other non-entry pages, and each collection. By default, article pages get a BlogPosting, as with EmDash's own JSON-LD, and everything else a WebPage.
- **Authors**: Person properties per byline. Bylines without saved properties use their name, website (or the author page URL), bio and avatar.
- **Overrides**: a different page or article type for a single entry.
- **Robots & social**: the search URL template (`/?s={search_term_string}` by default; empty for no SearchAction), the author page URL pattern (empty by default: set it to match your site's author pages, e.g. `/author/{slug}/`, so authors get a `url` and `@id` there; without it, authors without a byline website get no `url` and an `@id` on the site root), the breadcrumb home label, the robots directives (a blank max-snippet or max-video-preview means -1, no limit), and an `og:locale` override (derived from the site locale otherwise, e.g. `en` → `en_US`).
- **Preview**: the tags and JSON-LD the module would add to the home page or an entry.

### Setup

Nothing to configure beyond the Schema page. The module reads the site database (`DB` by default; set `schema: { database: "MY_DB" }` otherwise) to look up image dimensions and alt text, cached per Worker isolate for 10 minutes, and its settings are cached for 30 seconds. It needs the `content:read`, `schema:read`, `bylines:read` and `media:read` capabilities, which it declares.

### Notes

- Page types come from the page context your theme passes to `EmDashHead`: an entry page is matched to its collection through `content`, and `pageType: "article"` is what makes a page an article by default. Pages without `content` use the home page or "other pages" types.
- Derived breadcrumbs name parent segments from the URL (`/health-tips/` → "Health tips"); pass `breadcrumbs` in the page context for exact names.
- A content page costs a few extra database reads per render (the entry override, its bylines, and saved author properties); image lookups and settings are cached.

## Search

EmDash has full-text search built in: SQLite FTS5 with BM25 ranking, English stemming, prefix matching, highlighted snippets, a public API (`/_emdash/api/search`), and a `LiveSearch` component. This module adds what it leaves out. Turn on **Search** and its parts on the Features page (all off by default).

- **Search settings** (`search.settings`): a **Search** admin page to choose which collections are searchable, set field weights, pick the tokenizer (English stemming, exact words, or trigram substrings), and rebuild indexes with a progress readout and per-collection entry counts. It calls EmDash's own search API, so it needs EmDash's `search:manage` permission (admins). Fields are made searchable in each collection's schema.
- **Search box** (`search.box`): a `SearchBox` component with as-you-type suggestions (titles first, then full text), arrow keys, Enter and Escape, a clear button, content-type labels, highlighted matches, screen-reader announcements, and a fade that respects reduced motion. When nothing matches every word, it shows results for any of the words, ranked by how many they contain. Without JavaScript it's a plain search form that submits to your search page.
- **Search rate limit** (`search.rateLimit`): limits each visitor to 120 searches a minute (configurable) on EmDash's public search and suggestion endpoints and the pack's search route, answering `429` with `Retry-After`. Visitors are keyed by a salted hash of their IP address, never the address itself.

### Search box

```astro
---
import { SearchBox } from "@coywolf/emdash/astro";
---
<SearchBox action="/search" collections={["posts", "pages"]} placeholder="Search articles" />
```

Props: `action` (your search page, default `/search`), `name` (`q`), `label`, `showLabel`, `placeholder`, `collections`, `locale`, `minChars` (2), `debounce` (200 ms), `limit` (8), `showType`, `showSnippets`, `submitButton`, `value`, `class`, and `id` (set a different one for each box on a page). Its script (about 4 KB minified, 2 KB compressed) and styles load only on pages that render it, and nothing at all is sent while **Search box** is off. Suggestions are real links, so middle-click and "open in new tab" work.

Colors are CSS custom properties with light and dark defaults. Override them on `.cw-search`:

```css
.cw-search {
  --cw-search-bg: #fff;
  --cw-search-fg: #1a1a1a;
  --cw-search-muted: #5c5c5c;
  --cw-search-border: #d4d4d4;
  --cw-search-active-bg: #f1f1f1;
  --cw-search-active-border: currentColor;
  --cw-search-active-fg: inherit;
  --cw-search-mark: rgb(255 214 0 / 0.35);
  --cw-search-radius: 0.5rem;
}
```

Suggestions come from `GET /_emdash/api/plugins/coywolf-pack/search/query?q=…&mode=suggest`, which returns EmDash's results plus each entry's URL (from the collection's URL pattern) and type label. Use the same OR fallback on your search page:

```astro
---
import { searchWithFallback } from "@coywolf/emdash/astro";
const q = Astro.url.searchParams.get("q")?.trim() ?? "";
const { items, fallback } = q ? await searchWithFallback(q, { limit: 20 }) : { items: [], fallback: false };
---
{fallback && <p>No results for all of your words. Showing results for some of them.</p>}
{items.map((item) => <a href={item.url}>{item.title}</a>)}
```

Fallback results aren't paginated (the best 50 are ranked together).

### Rate limit setup

The limit is enforced by a [Workers Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) binding when you add one. Its limit and period (10 or 60 seconds) come from `wrangler.jsonc`:

```jsonc
"ratelimits": [
  { "name": "SEARCH_RATE_LIMITER", "namespace_id": "1001", "simple": { "limit": 120, "period": 60 } }
]
```

```js
coywolfPlugin({ search: { rateLimiter: "SEARCH_RATE_LIMITER" } });
```

- `rateLimiter`: the binding's name. Counting happens at Cloudflare (per location), so it holds across Worker isolates. Blocked requests get `Retry-After: 60`.
- Without a binding, each Worker isolate counts on its own (`requestsPerMinute`, default 120; `0` turns it off). That's best effort: it stops one client hammering one isolate, but it isn't a hard limit.
- Optional Worker secret `SEARCH_RATE_LIMIT_SALT` for the IP hash (recommended; a fixed built-in salt is used otherwise, so keys agree across isolates).
- Requires the pack middleware (`coywolfPack()` in `src/middleware.ts`). The admin endpoints (enable, rebuild, stats) aren't limited.

For a hard limit that never reaches your Worker, use a Cloudflare WAF rate limiting rule instead of (or as well as) this feature. The free plan includes one: **Security → WAF → Rate limiting rules**, match `URI Path starts with /_emdash/api/search` or `URI Path equals /_emdash/api/plugins/coywolf-pack/search/query`, counted per IP, for example 60 requests per 10 seconds with a 10-second block.

## Development

```bash
npx tsc --noEmit -p .        # typecheck
node --test test/*.test.mjs  # unit tests (Node 22.15+; runs the TypeScript sources directly)
```

## AI Enrichment

Ported from Coywolf SEO's AI features, with the same prompts and validation:

- **Entities for schema** (`ai.entities`). The model lists the people, organizations, places, and things a page is about, without identifiers. Each name is looked up on Wikidata (`wbsearchentities`), and only items whose label or alias is that name (ignoring case, accents, and punctuation) count. When several match, the model may only pick one of them. Each chosen item's `instance of` (P31) claims are then checked: disambiguation pages are dropped, a Person must be human, an Organization or Place can't be a creative work (the album instead of the band), and an Organization can't be a place. The JSON-LD `name` is Wikidata's label. The result is stored per entry as Schema.org `about` (main subjects) and `mentions`, each with `sameAs` links to Wikidata, Wikipedia, and the official website (P856) when there is one. Coywolf's Schema module reads them with `getEntryEntities(ctx | db, collection, id)` from `src/ai/entities.ts`.
- **Output entities on their own** (`ai.entitiesStandalone`). Adds the entities to the page's JSON-LD as a `WebPage` node (same `@id` as EmDash's `mainEntityOfPage`). Only for sites that don't use Coywolf Schema.
- **Meta descriptions** (`ai.descriptions`). Writes a description (under 155 characters, no clickbait) for published entries in SEO-enabled collections that don't have one. By default they're suggestions you edit and apply on the AI page; or have empty descriptions filled automatically. Either way it writes only EmDash's SEO panel field and never replaces a description someone wrote unless you choose **Replace**.
- **Image text** (`ai.imageText`). Writes alt text (and, if you turn it on, captions) for images on upload and in bulk, with accessibility-first prompts. Alt text and captions people wrote are kept unless you turn on overwrite. EmDash media has no title or description fields, so titles are shown on the AI page for reference only.

All four are off by default, under the **AI Enrichment** switch on the Features page.

### How it runs

Saving, publishing, or uploading never waits on AI: hooks only add the entry or image to a queue (after a short wait, so a burst of saves becomes one job, and only when the entry's text actually changed). A scheduled job works through the queue every two minutes, a few items at a time (**Items per scheduled run**), and stops for the day at **Max model calls per day** (default 200; an entry costs up to three calls, an image one). Each run also stays under 40 outbound requests (model calls plus Wikidata lookups), so it fits the Workers Free plan's subrequest limit; entries and images take turns, so a backlog of one doesn't hold up the other. Failed items are retried after 5 and 20 minutes, then marked as errors; a retry reuses the model output it already paid for. Deleting an entry removes its analysis. **Run bulk** on the AI page queues every published entry (skipping unchanged ones) or every image without alt text. The AI page also has a connection test, the queue status, suggestions to review, the analyzed entities, and a 30-day usage log with token counts.

### Setup

Pick a provider on **Plugins → AI Enrichment → Settings**:

- **Cloudflare Workers AI** (the default when the binding exists). Add the binding to `wrangler.jsonc`:

  ```jsonc
  "ai": { "binding": "AI" }
  ```

  The default model is `@cf/meta/llama-4-scout-17b-16e-instruct` for both text and images. A different binding name goes in `coywolfPlugin({ ai: { binding: "MY_AI" } })`.
- **Anthropic, OpenAI, or Google Gemini** with your own API key (stored encrypted, so the site needs `EMDASH_ENCRYPTION_KEY`). Defaults (checked October 2026): `claude-sonnet-5-5`, `gpt-6-luna`, `gemini-3.8-flash`. To use another model, such as a cheaper one or a newer one after a default is retired, enter its id in **Text model** and **Image model** on the Settings tab; leave them blank to follow the defaults.

Images are sent to the model at up to 3.5 MB. With a Cloudflare Images binding (`"images": { "binding": "IMAGES" }`, the same one EmDash uses for resizing) larger images are downscaled to 1568 pixels first; without one they're skipped. SVGs are skipped.

Set `ai: false` in `coywolfPlugin()` to leave the module out entirely. The module declares the `network:request` capability (for `api.anthropic.com`, `api.openai.com`, `generativelanguage.googleapis.com`, and `www.wikidata.org`), plus content read/write (SEO panel only), schema read, and media read, bytes, and metadata write.

### Notes

- Only published entries are analyzed. Change the model or switch features and entries are re-analyzed the next time they're saved (or with **Re-analyze unchanged entries**).
- The daily limit is counted in UTC days. Each call's token usage is in the usage log; costs depend on your provider.
- Wikidata lookups are cached per Worker isolate. If Wikidata doesn't answer, the item is retried rather than saved unverified.

## License

MIT
