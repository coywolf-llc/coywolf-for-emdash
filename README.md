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
| **Discovery** | IndexNow pings, a Google News sitemap, and llms.txt with Markdown versions of entries |
| **Link Manager** | Every link in your content with its HTTP status, where it's used, and bulk replace, unlink, and ignore |
| **Videos** | Cloudflare Stream library and uploads, the Coywolf Video block, VideoObject schema, a video sitemap, plays and likes, captions |
| **Schema & Social** | One Schema.org graph per page (publisher, typed pages and articles, authors), breadcrumbs, robots directives, Open Graph extras |
| **Robots.txt Rules** | Named robots.txt rules, a verified crawler directory kept current from Cloudflare Radar, and a URL tester |
| **AI Enrichment** | Wikidata-grounded entities for schema, meta-description suggestions, and image alt text, with Workers AI or your own key |

Every feature can be turned on or off under **Plugins → Features**, like Coywolf SEO's feature switches. New features start off, so installing or updating changes nothing on the site until you turn them on. A module that is off also leaves the admin sidebar and dashboard.

More modules will follow as Coywolf's WordPress plugins move to EmDash.

This is a native (trusted) EmDash plugin, so it installs from GitHub or npm rather than the EmDash plugin directory. The directory lists only sandboxed plugins, which can't read the database or buckets directly.

## Requirements

EmDash 1.1+ on the Cloudflare adapter, with a D1 database (`DB`) and an R2 media bucket (`MEDIA`).

## Install

```bash
npm install https://codeload.github.com/coywolf-llc/coywolf-pack/tar.gz/refs/tags/v0.4.10
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

Each module's settings live on its own page (Backups, Files → Settings, Videos → Settings, Link Manager → Settings, AI Enrichment → Settings, Schema, Code Blocks, Discovery, Robots.txt), grouped into sections. Features that need an API key or binding stay hidden until it's there, with a setup card in their place. The plugin's generic **Settings** page (**Plugins → Coywolf Pack → Settings**) lists only the API keys and tokens, which EmDash stores encrypted (so the site needs `EMDASH_ENCRYPTION_KEY`): the AI Enrichment API key, the File Downloads R2 secret access key, the Videos Stream API token and webhook secret, and the Cloudflare Radar API token. Each can also be entered on its module's page.

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

## Content URLs

Several modules link to entries: llms.txt and the news sitemap, IndexNow, per-entry Markdown, the video sitemap, Schema previews, search results, and removed-content redirects. By default they resolve an entry's URL the way EmDash does, from the collection's URL pattern (`{slug}`, `{id}`, and date tokens such as `{year}`). If your theme routes a collection differently, tell the pack with `urls`:

```js
// wellbeing.io serves posts at WordPress-style /{category}/{slug}/
coywolfPlugin({
  urls: { posts: "/{term:category|uncategorized}/{slug}/" },
});
```

Patterns take EmDash's tokens plus taxonomy tokens:

- `{term:<taxonomy>}` is the slug of the entry's first term in that taxonomy, in the order EmDash's `getTermsForEntries` returns them (by label).
- `{term:<taxonomy>|<fallback>}` uses `<fallback>` when the entry has no term. Without a fallback, an entry with no term has no URL.
- `{category}` is shorthand for `{term:category|uncategorized}`.

Collections without an override keep EmDash's resolution. The pack also maps paths back to entries (for example, the Markdown source at `/mind/some-post/index.html.md` resolves only when `mind` is the post's primary category), so a wrong category doesn't match.

Trailing slashes follow Astro's `trailingSlash` setting. With the default (`"ignore"`), an override keeps the pattern's own trailing slash. Set `trailingSlash: "always" | "never"` on `coywolfPlugin()` to force one for every entry URL the pack builds. Override URLs get no locale prefix.

The options are read when the Worker starts (EmDash creates the plugin then), so the middleware and Astro components use them too. Sites can resolve URLs the same way with `entryUrl`, `entryUrls`, and `matchEntryPath` from `@coywolf/emdash/astro`.

## Backups

- **Database**: a restorable SQL dump of the site's D1 database: users, passkeys, settings, redirects, menus, plugin data, and content. Search indexes rebuild automatically on restore.
- **Media**: a mirror of the R2 media bucket. Replaced or deleted files are kept under a dated folder until retention expires.
- **Admin**: **Back up now**, downloads, and a dashboard widget that warns when backups stop. Settings (**Schedule and retention** on the Backups page): daily scheduled backup (default off), retention (default 30 days), staleness warning (default 36 hours).
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
| `headings.toc` | off | **Table of Contents** block: title (shown or hidden), heading levels (any of H2–H6), plain/bulleted/numbered (1, 1.1, 1.1.1), always open or collapsible (open or collapsed) |
| `headings.breadcrumbs` | off | **Breadcrumbs** block and a `Breadcrumbs` component for themes |

Site defaults live on **Headings & TOC**: id prefix, copy link, scroll offset for sticky headers (px or rem), TOC defaults (title, show title, levels, style, display, minimum headings, smooth scrolling), and breadcrumb separator, home label, and whether to show home and the current page.

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
2. Settings (**Files → Settings**): download URL base (default `download`), optional public bucket / CDN URL, card color scheme, accent color, and largest upload (default 5 GB).
3. Bindings: `DB` and `MEDIA`. To keep large uploads in their own bucket, bind it as `FILES` (or pass `files: { uploads: "MYBINDING" }`, and note the middleware looks for `FILES`).

### Large uploads

1. Create an R2 API token (**R2 → Manage API tokens**) with **Object Read & Write** on the bucket. Enter the account ID, access key ID, secret access key (stored encrypted), and bucket name under **Files → Settings → Large uploads**. Until all four are saved, the Files page shows a setup card instead of the uploader and the CORS check. The bucket must be the one bound as `MEDIA` (or `FILES`), since downloads stream through that binding.
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
- **Language label**, **Copy button** and **Line numbers** are sub-features. The copy button follows the WordPress plugin's accessible pattern: a labeled button, a polite live region that announces "Copied to clipboard", a two-second confirmation, and no animation for visitors who prefer reduced motion. Line numbers are drawn with CSS, so they're never selected or copied. The header shows the language on the left (file names aren't shown) with the copy button on the right.
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
## Discovery

Help search engines and AI agents find your content. Ported from Coywolf SEO for WordPress. Everything is off until you turn it on under **Features**: the **Discovery** switch, then any of its three parts. Settings and status are under **Plugins → Coywolf Pack → Discovery**.

| Feature switch | Default | What it does |
| --- | --- | --- |
| `discovery` | off | Main switch for the module |
| `discovery.indexnow` | off | IndexNow submissions and the key file |
| `discovery.newsSitemap` | off | `/news-sitemap.xml` |
| `discovery.llms` | off | `/llms.txt`, Markdown versions of entries, and the `<link rel="alternate" type="text/markdown">` head tag |

- **IndexNow**: when an entry is published, updated (in collections without draft revisions), unpublished, or deleted, its public URL goes to `api.indexnow.org` (or `www.bing.com`), which shares it with Bing, Yandex, Seznam, Naver, and the other participating engines. Changes made within 3 seconds of each other go out as one request, after the response is sent. A changed slug submits the old URL too. Entries set to noindex aren't submitted. The key is generated the first time it's needed (or when you open the Discovery page with IndexNow on) and served at `/<key>.txt`; **New key** replaces it. The page shows the last 25 submissions and has **Submit home page** for checking the setup.
- **News sitemap**: entries published in the last 48 hours (the window Google News uses), newest first, at most 1,000, with publication name and language (defaults: site title and locale). Choose the collections (default: `posts`). Also served at `/coywolf-news-sitemap.xml`, Coywolf SEO's URL, so a sitemap submitted from WordPress keeps working. Submit it in Google Search Console; to list it in robots.txt, add `Sitemap: https://example.com/news-sitemap.xml` to the custom robots.txt under **Settings → SEO**. The module doesn't change robots.txt.
- **llms.txt** ([llmstxt.org](https://llmstxt.org/)): the site name, a summary (default: the site tagline), an optional introduction, then one list per collection (newest first, 100 per collection) and an **Optional** list for the rest, up to 500 entries (configurable up to 5,000). Each link points at the entry's Markdown version, or at the page itself when Markdown is off. Excerpts (`excerpt` field or SEO description) become link notes. A static `public/llms.txt` takes precedence, because Cloudflare serves static assets before the Worker runs.
- **Markdown versions**: each entry at its URL + `index.html.md` (`/blog/post/` → `/blog/post/index.html.md`, Coywolf SEO's convention). The Portable Text body becomes Markdown (headings, paragraphs, lists, links, images with captions, code, block quotes, tables, and horizontal rules; other blocks are skipped) under YAML frontmatter with the title, URL, dates, sources, and an optional license. There's no `Accept: text/markdown` negotiation on the entry's own URL: Cloudflare's cache key ignores `Accept`, so one such request could put Markdown into the cached HTML page. Responses carry `X-Markdown-Tokens`, an estimate at about 4 characters per token. Entry pages get `<link rel="alternate" type="text/markdown">` in the head.

Only published, non-noindex entries in routable collections are included. URLs come from EmDash's own routing (each collection's URL pattern, date tokens, locale prefix, and trailing-slash setting), so they match the native sitemap.

### Setup

Nothing to configure beyond the feature switches. The module's site URLs are served by the pack middleware (see Redirects → Setup), so add `coywolfPack()` from `@coywolf/emdash/middleware` to `src/middleware.ts` if you haven't. The plugin asks for `content:read`, `schema:read`, `network:request` (hosts `api.indexnow.org` and `www.bing.com`), and `hooks.page-fragments:register`.

### Caching and limits

- llms.txt and the news sitemap are stored in plugin storage and visitors are always served the stored copy. Content changes (publish, unpublish, delete, or a live edit) and settings saves rebuild them in the background after the response, debounced by 5 seconds; a copy older than its limit (5 minutes for the news sitemap, whose window moves; 24 hours for llms.txt) is served once more while a background rebuild runs. Only the very first request, before anything is stored, builds inline. **Rebuild now** on the Discovery page rebuilds both immediately. Each Worker isolate also keeps responses for a minute (up to about 2 MB), and CDNs may keep `llms.txt` and `.md` files for an hour (`Cache-Control: public, max-age=3600`; 5 minutes for the news sitemap).
- Markdown URLs resolve through EmDash's routing (`resolveEmDashPath`, or `/{collection}/{slug}` for collections without a URL pattern), then are checked against the entry's public URL. Entries behind a locale prefix or a custom route don't get a Markdown version.
- An entry's old URL is known only if it was published while IndexNow was on, so unpublishing or deleting an entry published earlier submits nothing.
- The news sitemap has no category include/exclude filter (Coywolf SEO's WordPress option); pick collections instead. Coywolf SEO's AI entity sections (a Labs feature) aren't ported.

## Link Manager

An inventory of every link in your content, ported from Coywolf SEO's Link Manager:

- **Inventory**: link marks in Portable Text (including nested blocks, columns and tables), linked images, buttons, embeds, iframes, and URL fields. Each link shows its anchor text, internal or external, and the entries that use it, with links to edit them. Entries are re-indexed when they're saved, deleted or restored; **Scan content** (and a background job on first use) indexes everything else.
- **Checking** (sub-feature): every 5 minutes a background job checks links that are due: HEAD first, then GET when HEAD is refused, 10-second timeout, up to 5 redirects recorded. Statuses are **OK**, **Redirect** (with where it ends up), **Broken** (4xx/5xx), **Blocked** (403, 429, LinkedIn's 999, or a Cloudflare/AWS/DataDome bot challenge: the link is probably fine but can't be verified from a server), and **Error** (DNS, TLS, timeout, too many redirects). Broken links and errors are rechecked daily, the rest weekly. **Check now** and **Recheck** run checks on demand.
- **Bulk actions**: **Replace** a URL across every entry that uses it (link text and other formatting are kept), **Unlink** (the text stays; linked images and buttons lose their link; embeds are left alone), **Ignore** a URL or domain, and **Recheck**. Ignore rules can also be domains, exact URLs, wildcards (`https://example.com/visit/*`) or regular expressions. Ignored links aren't checked or counted.
- **Dashboard widget** with the number of broken links.

Feature switches: **Link Manager** (`links`) and **Scheduled link checking** (`links.check`), both off by default.

### Setup

No bindings or secrets, but EmDash needs to know the site URL (**Settings → General**, or `site` in `astro.config`) to tell internal links from external ones; nothing is indexed until it's set. Settings (**Link Manager → Settings**): subrequests per check run (default 40), whether to check links to your own site (default on), and a User-Agent override. The checker presents a current desktop Chrome by default, which avoids most false "Blocked" results.

### Notes

- Edits go through EmDash's content API. A published entry is republished so the fix goes live. An entry with unpublished changes (or a schedule) is fixed in its draft only, so its live version keeps the old link until the draft is published (the result message says how many). An entry saved by someone else while the action runs is left alone and reported, so run the action again for it. An editor with the entry open may still overwrite the change on their next save.
- The inventory follows each entry's latest saved version (its pending draft, if it has one). Links inside raw HTML blocks aren't tracked.
- Workers limit subrequests per invocation (50 on Free, 1,000 on Paid), and database calls count. A checked link takes 1–2 requests plus 1 per redirect, and 1 database write; keep **subrequests per check run** under your plan's limit, leaving room for other scheduled jobs. Scans run in steps of about 200 database statements (60 seconds) every 5 minutes, or faster while the Link Manager page is open; admin actions stop at about 150 statements or 25 seconds and continue on the next call.
- Links are stored in plugin storage (`links_urls`, `links_refs`) in the site's D1 database, so backups include them. The list pages through indexed queries; search matches the start of a URL (when it starts with `http` or `/`) or of a domain. Status counts are cached for up to a minute (10 minutes in the dashboard widget).
- Regular-expression ignore rules are limited to 200 characters, and patterns that can take exponential time (repeated groups containing a quantifier or alternation, backreferences) are refused.
### Checking internal links

A Worker can't fetch its own custom domain over HTTP (Cloudflare answers 522), so internal links are checked through a service binding to the site's own Worker. Add it to `wrangler.jsonc` (use your Worker's `name`):

```jsonc
"services": [{ "binding": "SELF", "service": "mysite" }]
```

Without the binding, internal links are listed but not checked (they're never reported as broken).

## Videos

The Coywolf Video Manager for EmDash, on Cloudflare Stream.

- **Coywolf Video block** (slash menu → Media): pick a video from your Stream library, then set a title, description, poster (a frame time or an image), start time, controls/autoplay/loop/muted/preload, full or maximum width, and whether to show the title, description, plays, a like button and the upload date. The **Loop like a GIF** style plays muted, autoplaying and looping with no controls. Server-rendered: the Stream player in a `<figure>`, lazy-loaded, sized by the video's aspect ratio so nothing shifts.
- **Admin** (**Plugins → Coywolf Pack → Videos**): the library with thumbnails, length, upload date, plays, likes and the number of entries each video is used in; search; edit name, description, poster, allowed origins and MP4 downloads; captions; and uploads that go straight from the browser to Stream (tus for files over 200 MB), so they never pass through the Worker.
- **Embed index**: saving, publishing, unpublishing, restoring or deleting an entry records which videos it embeds (any Portable Text field, at any depth). **Rebuild embed index** scans existing content. WordPress `cloudflare-stream` marker blocks (as imported to wellbeing.io) are indexed too, for usage counts and the sitemap.

| Feature | Default | What it adds |
| --- | --- | --- |
| `videos` | off | The module: library, uploads, block, index |
| `videos.schema` | off | A VideoObject JSON-LD script per embedded video (`page:metadata`, one script per video, never `primary`): name, description, 1200px thumbnail, ISO 8601 duration, upload date, embed URL, the MP4 as `contentUrl` when downloads are on, view and like counts when plays and likes are on, and caption tracks plus a transcript (up to 10,000 characters) when captions are on |
| `videos.sitemap` | off | A Google video sitemap at `/coywolf-video-sitemap.xml` for published entries (cached 10 minutes; rebuilt when content changes) |
| `videos.engagement` | off | Plays (counted once per browser session after 2 seconds of playback, not for autoplaying videos) and likes (one per visitor per day, using a daily-salted hash of IP and user agent; no cookies, nothing personal stored) |
| `videos.captions` | off | Upload WebVTT, generate captions with Stream, delete; ready tracks are copied to the site and served at `/coywolf-video-captions/<id>/<lang>.vtt` |
| `videos.webhook` | off | A Stream webhook (HMAC-verified) that refreshes a video's details as soon as Stream finishes processing it; **Subscribe** on the Videos page |

### Setup

1. Create an API token with **Account → Stream → Edit**.
2. On the **Videos** page, enter the account ID and the token in the **Connect** card (or later under **Videos → Settings**; the token is a secret setting, which needs EmDash's `EMDASH_ENCRYPTION_KEY`). Until Stream is connected, the page shows only that card: the library, uploads, captions and the webhook appear once it's connected. Or set `CF_ACCOUNT_ID` and the `CF_STREAM_TOKEN` Worker secret, the same variables EmDash's `cloudflareStream()` media provider reads. Optional settings (**Videos → Settings → Player**): the customer subdomain (`customer-….cloudflarestream.com`, learned from the library if empty), and the player accent and background colors.
3. Turn on **Videos** (and any sub-features) under **Plugins → Coywolf Pack → Features**, open the **Videos** page, and click **Test connection**. Then **Rebuild embed index** once.
4. For the sitemap and caption files, add `coywolfPack()` to the site middleware (see Redirects), and list the sitemap in `robots.txt`:

   ```text
   Sitemap: https://example.com/coywolf-video-sitemap.xml
   ```

Option: `videos: { maxUploadDurationSeconds: 3600 }` (the longest upload Stream accepts; Stream reserves that much quota while an upload is in progress). `videos: false` leaves the module out.

Use the block from theme code too: `import { CoywolfVideo } from "@coywolf/emdash/astro"` and `<CoywolfVideo node={{ uid, preset: "gif" }} />`. It also accepts the WordPress marker attributes (`id`, `host`, `aspect`, `name`, `description`, `seconds`), which default to the GIF style, so it can replace a theme's own Stream component. Those marker blocks don't get schema from this module, because a theme rendering them usually emits its own.

### Limits

- Stream lists up to 1,000 videos per call; the library is cached for 5 minutes (plugin KV and isolate memory). **Refresh** reloads it.
- Page views make no Stream API calls: player sizes, names and counts come from the site's own copy, filled when the library loads, when an entry with a new video is saved, and by the webhook.
- Plays aren't counted for autoplaying videos (including the GIF style), so muted previews don't inflate them. Visitors who block `embed.cloudflarestream.com` (the player SDK, loaded only where plays are counted) aren't counted.
- Signed URLs (`requireSignedURLs`) aren't supported.

## Robots.txt Rules

Write `robots.txt` as named, plain-English rules instead of a text box: **Block AI training crawlers**, **Block AI search and assistants**, **Allow search engines**, **Block SEO tool crawlers**, or a custom path rule (a folder, a prefix, one page, an exact URL, a file type, a query parameter, a wildcard, or "block a folder but allow one item in it"). Pick crawlers by category or search from a directory of about 700 bots, see the generated file as you edit, and test it: **Can GPTBot fetch /2026/my-post/?** The tester runs a TypeScript port of Google's open-source robots.txt matcher (RFC 9309: a bot's own groups are merged and shadow `*`, longest match wins, Allow wins ties, `*` and `$` wildcards), against exactly what will be served.

The pack middleware serves `/robots.txt` while the feature is on, so turning it off falls straight back to EmDash's own robots.txt (and until you first save rules, EmDash's keeps being served). We serve it rather than writing into EmDash's **SEO → robots.txt** setting because that setting is capped at 5,000 characters (an AI-crawler blocklist outgrows it), and because a generated file has to keep EmDash's required lines in every group: crawlers obey only the groups that name them, so a bot with its own rule would otherwise skip `Disallow: /_emdash/`. The generated file adds a group for `*` and every bot named in a rule with `Allow: /_emdash/api/media/` (EmDash serves uploaded images there) and `Disallow: /_emdash/`, leaves the media Allow out for bots blocked from the whole site, and ends with `Sitemap: <site URL>/sitemap.xml` plus any sitemaps you add. If EmDash has a custom robots.txt, the page offers to copy its lines into **Extra lines**.

Feature switches: **Robots.txt Rules** (`robots`) and **Weekly crawler list from Cloudflare Radar** (`robots.radarSync`). Both default to off.

### Setup

Uses the same `coywolfPack()` middleware as Redirects, and the `DB` binding. A static `public/robots.txt` in the site would be served by Workers static assets before the Worker runs, so remove it. Rules are read at most once a minute per Worker isolate; the response is cached for an hour (`Cache-Control: public, max-age=3600`).

### The crawler directory

A robots.txt `User-agent:` line takes a product token (`GPTBot`, `Claude-SearchBot`, `meta-externalagent`), which often isn't the bot's name or full user-agent string. The bundled directory (`src/robots/data/bots.json`) starts from Cloudflare Radar's bot directory and Coywolf SEO's curated tokens, and records for every bot how its token was confirmed:

- **verified, operator docs**: the operator's own documentation names the token (`sourceUrl`, `verifiedAt`). The major AI crawlers and search engines were re-checked on 2026-10-03: OpenAI, Anthropic, Google (including Google-Extended), Bing, Apple (Applebot-Extended), Perplexity, Common Crawl, Amazon, Meta, DuckDuckGo, Yandex, Baidu, Mistral, Webz.io and ImageSift.
- **verified, user agent**: the token appears in the user-agent string Radar publishes for the bot.
- **unverified**: derived from a pattern or name, or a legacy token the operator no longer documents (for example `anthropic-ai`, `Claude-Web`, `FacebookBot`, `cohere-ai`). These still work in robots.txt if the crawler uses them, and are flagged in the picker.

Signed agents that identify only cryptographically (Web Bot Auth) and have no token, such as ChatGPT agent, are left out. Bots that share a token (for example the nine regional Amazon Bedrock AgentCore browsers) are one entry, and hash-like identifiers that aren't product tokens are flagged unverified.

To rebuild the list, run `scripts/build-bots.mjs`. It reads Cloudflare Radar's directory (`RADAR_API_TOKEN`, or a snapshot saved earlier with `--save-snapshot` and passed back with `--radar-snapshot`), Coywolf SEO's curated tokens (`--wp <dir>`, or fetched with `gh api` from coywolf-llc/coywolf-seo), and the hand-verified tokens in `src/robots/data/verified.json`. To verify a token, add it to `verified.json` with the operator's documentation URL and the date you checked it, then rerun:

```bash
RADAR_API_TOKEN=… node scripts/build-bots.mjs
```

### Weekly refresh from Cloudflare Radar

With `robots.radarSync` on and a token set, the `robots-refresh-bots` task runs weekly (and **Refresh from Radar** runs it now). It makes one request, `GET https://api.cloudflare.com/client/v4/radar/bots?limit=1000`, and stores only differences from the bundled list in plugin storage (`robots_bots`), so a quiet week writes nothing. Radar publishes user-agent patterns, not robots.txt tokens, so bots that first appear this way get a token derived from their pattern and stay **unverified** until the bundled list is updated with a source. Bots that leave Radar stay usable and are marked.

Create a Cloudflare API token with **Account → Radar → Read** and either paste it into the setup card under **Crawler directory** on the Robots.txt page (stored encrypted; it's also on the plugin's generic Settings page) or set it as a Worker secret:

```bash
npx wrangler secret put RADAR_API_TOKEN
```

The module declares `network:request` for `api.cloudflare.com` only.

## Development

```bash
npx tsc --noEmit -p .        # typecheck
node --test test/*.test.mjs  # unit tests (Node 22.15+; runs the TypeScript sources directly)
```

## License

MIT
