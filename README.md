# Coywolf Pack for EmDash

One plugin with [Coywolf](https://coywolf.com)'s features for [EmDash](https://emdashcms.com) sites on Cloudflare: the things Coywolf's WordPress plugins do that EmDash doesn't do natively. Enable only the modules you want.

| Module | What it does |
| --- | --- |
| **Backups** | Full backups (D1 database + R2 media), rewind with undo, restore to a new database, missing-media restore |
| **Redirects** | Redirect manager for what EmDash's built-in Redirects can't handle: external destinations and file paths |
| **Headings & TOC** | Linkable headings (`#jump-…` anchors) and a Table of Contents block |
| **Breadcrumb Nav** | An accessible breadcrumb trail as a theme component and a Breadcrumbs block, fed by the same trail as the breadcrumb schema |
| **Code Blocks** | Server-side syntax highlighting, themes, language label, copy button and line numbers for code blocks |
| **File Downloads** | A download card block, stable download URLs with counts, a Files page, and direct-to-R2 uploads of any size |
| **Search** | Settings page for EmDash's full-text search, a search box with as-you-type suggestions and an OR fallback, and rate limiting |
| **Discovery** | IndexNow pings, a Google News sitemap, and llms.txt with Markdown versions of entries |
| **Link Manager** | Every link in your content with its HTTP status, where it's used, and bulk replace, unlink, and ignore |
| **Videos** | Cloudflare Stream library and uploads, the Coywolf Video block, VideoObject schema, a video sitemap, plays and likes, captions |
| **Reviews** | The Coywolf Review block (rating badge, pros and cons) with custom CSS, and Review schema with pros and cons |
| **Custom Blocks** | Note (callout), Details (expandable, with a transcript style), Affiliate disclosure, Quote, Testimonial and Podcast links blocks |
| **Schema & Social** | One Schema.org graph per page (publisher, typed pages and articles, authors), breadcrumbs, robots directives, Open Graph extras |
| **Robots.txt Rules** | Plain-English robots.txt rules with a guided editor, live checks and a self-check, a verified crawler directory kept current from Cloudflare Radar, version history, and a URL tester |
| **WordPress import** | Turns what Coywolf's WordPress plugins left in content (Stream and Video Manager videos, reviews, tables of contents, file downloads, heading ids, sidenotes, transcripts, quotes, disclosures, testimonials, podcast links) into Coywolf Pack blocks during and after an EmDash import, and gives guest authors their own bylines |
| **AI Enrichment** | Wikidata-grounded entities for schema, meta-description suggestions, and image alt text, with Workers AI or your own key |

Every feature can be turned on or off under **Plugins → Coywolf Pack**, like Coywolf SEO's feature switches. New features start off, so installing or updating changes nothing on the site until you turn them on. A module that is off also leaves the admin sidebar and dashboard.

More modules will follow as Coywolf's WordPress plugins move to EmDash.

This is a native (trusted) EmDash plugin, so it installs from GitHub or npm rather than the EmDash plugin directory. The directory lists only sandboxed plugins, which can't read the database or buckets directly.

## Requirements

EmDash 1.1+ on the Cloudflare adapter, with a D1 database (`DB`) and an R2 media bucket (`MEDIA`).

## Install

```bash
npm install https://codeload.github.com/coywolf-llc/coywolf-pack/tar.gz/refs/tags/v0.13.1
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

Each module's settings live on its own page (Backups, Files → Settings, Videos → Settings, Link Manager → Settings, AI Enrichment → Settings, Schema, Code Blocks, Discovery, Robots.txt), grouped into sections. Features that need an API key or binding stay hidden until it's there, with a setup card in their place. The plugin's generic **Settings** page (**Plugins → Coywolf Pack → Settings**) lists only the API keys and tokens, which EmDash stores encrypted (so the site needs `EMDASH_ENCRYPTION_KEY`): the AI Enrichment API key, the File Downloads R2 secret access key, the Videos Stream API token and webhook secret, and the Cloudflare Radar API token. Each can also be entered on its module's page, which has a step-by-step guide (closed by default) for getting it; the Settings page shows the same guides (the pack's middleware adds them to that EmDash page; without it, each field keeps a short plain-text version).

Settings pages save from one bar pinned to the bottom of the page: it appears only when there are unsaved changes, with **Discard** (back to what's saved) and **Save** (also Ctrl/⌘+S), and the browser asks before you leave with changes unsaved.

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
- `{termpath:<taxonomy>}` (and `{termpath:<taxonomy>|<fallback>}`) is the same term with its parent terms in front, root first, like WordPress's `%category%` permalink: `news/seo` for SEO under News, `guides/method-seo/structure` three levels down. A term with no parent is just its slug. Parents come from EmDash's categories (the parent set under **Taxonomies**), read once per request or build. Chains stop at a loop or after 32 levels.
- `{pagepath}` is the entry's slug with its parent pages' slugs in front (`apps/coywolf-seo`). EmDash entries have no parent field, so the parents come from the `pageParents` option (slug → parent slug). An entry with no parent is just its slug.

```js
// coywolf.com: WordPress's /%category%/%postname%/ with the full category path, and nested pages
coywolfPlugin({
  urls: {
    posts: "/{termpath:category|uncategorized}/{slug}/",
    pages: "/{pagepath}/",
  },
  pageParents: { "coywolf-seo": "apps", "coywolf-files": "apps" },
  // Optional: parents for categories that have none in EmDash yet (e.g. right after a WordPress import).
  termParents: { category: { seo: "news", "method-seo": "guides", structure: "method-seo" } },
});
```

`termParents` (taxonomy → term slug → parent slug) is a fallback: it's used only for terms that have no parent in EmDash, so once the parents are restored (see [Migrating from WordPress](#migrating-from-wordpress), "Category and page parents") it can go.

Collections without an override keep EmDash's resolution. The pack also maps paths back to entries (for example, the Markdown source at `/mind/some-post/index.html.md` resolves only when `mind` is the post's primary category), so a wrong category doesn't match. With `{termpath:…}` the whole path must match: `/news/seo/some-post/` resolves, `/seo/some-post/` doesn't (the theme should redirect it, as WordPress did). With `{pagepath}`, a page under a parent resolves only at its full path.

Trailing slashes follow Astro's `trailingSlash` setting. With the default (`"ignore"`), an override keeps the pattern's own trailing slash. Set `trailingSlash: "always" | "never"` on `coywolfPlugin()` to force one for every entry URL the pack builds. Override URLs get no locale prefix.

The options are read when the Worker starts (EmDash creates the plugin then), so the middleware and Astro components use them too. Sites can resolve URLs the same way with `entryUrl`, `entryUrls`, and `matchEntryPath` from `@coywolf/emdash/astro`.

## Clean Image URLs

Resized copies of media-library images at short, cacheable addresses instead of Astro's `/_image?href=…&w=…&h=…` endpoint. Off until you turn on **Clean image URLs** on the Coywolf Pack page.

```
/media/<file id>-<width>x<height>.<webp|avif|jpg|png>   cropped to fill (fit: cover)
/media/<file id>-<width>w.<format>                      width only, keeps the ratio
```

The pack's middleware reads the original from the media bucket (`MEDIA`), resizes it with the Cloudflare Images binding (`IMAGES`, which the Astro Cloudflare adapter already binds), and caches the result at the edge for a year (file ids never change). Sizes are limited to 2560px; SVGs aren't resized. Other binding names: `coywolfPlugin({ images: { bucket: "MYMEDIA", images: "MYIMAGES" } })`.

In theme code, build URLs with `cleanImageUrl` (returns `null` when the feature is off or the source isn't a media-library file, so fall back to your usual image code):

```astro
---
import { cleanImageUrl } from "@coywolf/emdash/astro";
const thumb = await cleanImageUrl(post.data.featured_image?.src, { width: 600, height: 315 });
---
{thumb && <img src={thumb} width="600" height="315" alt="" />}
```

## Backups

- **Database**: a restorable SQL dump of the site's D1 database: users, passkeys, settings, redirects, menus, plugin data, and content. Search indexes rebuild automatically on restore.
- **Media**: a mirror of the R2 media bucket. Replaced or deleted files are kept under a dated folder until retention expires.
- **Admin**: **Back up now**, **Download** any backup (see below), and a dashboard widget that warns when backups stop. Settings (**Schedule and retention** on the Backups page): daily scheduled backup (default off), retention (default 30 days), staleness warning (default 36 hours).
- **Restore** (optional, see below): **Rewind to this backup** (D1 Time Travel, with **Undo rewind**), **Restore to a new database** (import plus per-table row-count check), and **Restore missing media**.

Theme code isn't included: it lives in your Git repository.

### Download a backup

Each backup's menu has **Download (.sql.gz)**: the gzipped SQL dump of the whole database, saved as `<name>-<stamp>.sql.gz`. It restores into any D1 database (see **Manual restore**), so you always have your own copy. The page asks the `backups/download-link` route (admins only) for a link that works for ten minutes, and the `coywolfPack()` middleware streams the file from R2 at `/_coywolf-pack/backup/<token>/<file name>`, so dumps of any size download without the Worker holding them in memory. Links are random, unlisted tokens stored in the backup bucket (`downloads/`), sent with `Cache-Control: private, no-store`; expired ones are deleted when the next link is made. Media isn't part of the download: the media mirror stays in the backup bucket (copy it with `rclone` or the R2 dashboard).

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
3. Downloads need the `coywolfPack()` middleware (see the Redirects setup).

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
downloads/<token>.json           download links (ten minutes each)
```

External jobs (a nightly GitHub Action, for example) can write to the same layout, and the admin lists those backups too.

### Manual restore

Restore a downloaded backup (or one copied from the bucket) into a **new, empty** D1 database and switch the `DB` binding to it. Never import over the live database:

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

Features: exact paths (with or without a trailing slash) or regular expressions with `$1`–`$9` substitution, 301/302/307/308/410, enable/disable, notes, hit counts, a URL tester, bulk import (paste or choose a file: JSON, or tab/comma-separated `source, target, type, is_regex` rows; a Coywolf SEO export from WordPress works as is), and **Export** as CSV or JSON. Rules are stored in the site's D1 database (`coywolf_redirects`), so backups include them.

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

### Export and move redirects

**Export** (next to Import) downloads every rule as CSV (for spreadsheets) or JSON. Either file imports back on this or any other site through **Import → Choose file**, updating rules with the same source:

- CSV columns: `source, target, type, is_regex, enabled, note`, then `hits, last_hit, created_at, updated_at` for reference (Import ignores them, so hit counts start over on the new site). Cells that a spreadsheet would run as a formula (starting with `=`, `+`, `-` or `@`) get a leading apostrophe, which spreadsheets hide; Import removes it again, so the round trip is exact.
- JSON: an array of rules, as the list route returns them.

Import takes up to 5,000 rules (2 MB) at a time; split bigger files.

## Headings & TOC

Ported from Coywolf SEO. Off until you turn it on under **Plugins → Coywolf Pack**:

| Feature | Default | What it does |
| --- | --- | --- |
| `headings` | off | Main switch |
| `headings.anchors` | off | Every H2–H6 gets an id like `jump-pricing`, plus an optional "copy link to section" button on hover and focus |
| `headings.toc` | off | **Table of Contents** block: title (shown or hidden), heading levels (any of H2–H6), plain/bulleted/numbered (1, 1.1, 1.1.1), always open or collapsible (open or collapsed) |

Site defaults live on **Headings & TOC**: id prefix, copy link, scroll offset for sticky headers (px or rem), and TOC defaults (title, show title, levels, style, display, minimum headings, smooth scrolling). Breadcrumbs moved to their own module, [Breadcrumb Nav](#breadcrumb-nav), in 0.6.0.

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

### Notes

- Output is server-rendered. Collapsing uses `<details>`, smooth scrolling is CSS (and is skipped for visitors who prefer reduced motion), and the only script is a small inline one for the copy-link button, sent only when that option is on.
- Markup follows Coywolf SEO's accessibility rules: the TOC is a labeled `<nav>` (its title is never a heading inside `<summary>`).
- The module declares the `content:write` capability (EmDash only registers a `content:beforeSave` hook for plugins that have it; the hook changes nothing but heading anchors and the TOC block's stored data) and `content:read`. Anchors are kept across edits by matching block keys (then heading text) against the stored entry. When an entry has unpublished draft revisions, anchors of headings added in an earlier draft are matched by text.
- Styles use `cw-` classes and the theme's colors, in light and dark mode.
- With the features off, markup is unchanged, but the components' small global stylesheet (`cw-` classes only) is still bundled on pages that import them.

## Breadcrumb Nav

An accessible breadcrumb trail (`<nav aria-label="Breadcrumb">` around an `<ol>`, `aria-current="page"` on the current page, separators in CSS that screen readers skip), as a component for theme layouts and as a **Breadcrumbs** block for content. Off until you turn it on under **Plugins → Coywolf Pack**:

| Feature | Default | What it does |
| --- | --- | --- |
| `breadcrumbs` | off | Main switch: the `Breadcrumbs` component, the **Breadcrumbs** block, and the **Breadcrumb Nav** page |

Until 0.6.0 this was the `headings.breadcrumbs` sub-feature of Headings & TOC. Sites keep their state: while `breadcrumbs` has never been saved, it follows the stored `headings.breadcrumbs` switch (on only if Headings & TOC was on too), and the settings fall back to the breadcrumb defaults stored with Headings & TOC until the Breadcrumb Nav page saves its own. The block type (`coywolf-breadcrumbs`), the `Breadcrumbs` export and the stored block data are unchanged, and Breadcrumb Nav no longer depends on Headings & TOC being on.

Site defaults live on **Breadcrumb Nav** (with a live preview): separator (`/`, `›`, `»`, `•`, `→`, `>`, or a custom string of up to 8 characters), home label, and whether the trail starts with the home page and ends with the current page. The page also has a step-by-step guide for adding the component to a theme, with copyable code.

### Setup

Add the component to a layout, passing the same page context you give `EmDashHead`:

```astro
---
import { EmDashHead } from "emdash/ui";
import { createPublicPageContext } from "emdash/page";
import { Breadcrumbs } from "@coywolf/emdash/astro";

const page = createPublicPageContext({ Astro, kind: "custom", title, pageTitle: title, breadcrumbs });
---
<EmDashHead page={page} />
…
<Breadcrumbs page={page} />
```

Give each page its real trail with `breadcrumbs` (root first, current page last); `[]` hides the trail on that page, and leaving it out derives one from the URL:

```js
breadcrumbs: [
  { name: "Home", url: "/" },
  { name: category.label, url: `/${category.slug}/` },
  { name: entry.data.title, url: Astro.url.pathname },
],
```

Props: `page` (the `PublicPageContext` you pass to `EmDashHead`), `items` (`{ name, url }[]`), `title`, `separator` (`slash`, `chevron`, `guillemet`, `bullet`, `arrow`, `gt`, or any short string), `homeLabel`, `showHome`, `showCurrent`, `class`, `label` (the nav's `aria-label`, default "Breadcrumb"). Props override the site defaults.

The trail comes from, in order: `items`, `page.breadcrumbs`, the trail the theme gave `EmDashHead` for the same URL (picked up by the module's `page:metadata` hook, so the Breadcrumbs block uses it too), or the URL path (home, one crumb per path segment with a readable name, then the page title). Give themes with archives or nested content a real trail through `page.breadcrumbs`: derived ancestor links point at whatever the path segments are, which may not be pages.

With Schema & Social's `schema.breadcrumbs` on, the `BreadcrumbList` is built from the same `page.breadcrumbs`, so one trail feeds both the visible nav and the structured data. The schema uses the trail as given (include Home and the current page); the nav applies the start-with-home and end-with-current settings.

Without theme changes, add a **Breadcrumbs** block to an entry instead. Each block can override the separator, home label, and whether the current page shows; the entry's title is saved with the block for the last crumb.

### Styling

Classes: `.cw-breadcrumbs` (the `<nav>`, plus `.cw-breadcrumbs--sep-<preset>`), `.cw-breadcrumbs__list` (the `<ol>`, a wrapping flex row), `.cw-breadcrumbs__item` (each `<li>`; the separator is its `::before`), `.cw-breadcrumbs__current` (the current page). The separator is the `--cw-bc-sep` custom property (a CSS string). Links use the theme's colors. The component's rules are single-class, so a selector like `.site-header .cw-breadcrumbs a { … }` overrides them regardless of stylesheet order.

### Notes

- Server-rendered with no script; the small global stylesheet (`cw-` classes only) is bundled on pages that import the component, even with the feature off.
- A trail of one crumb (just Home, or just the page) isn't shown.
- The Breadcrumbs block picks up the theme's trail only when the theme renders `<EmDashHead page={page} />` with the page's real `url`; it's matched by path and query string, so locales and variants don't mix.
- The module's `content:beforeSave` hook only writes `_title` on Breadcrumbs blocks (it declares the `content:write` capability EmDash requires for the hook).
## File Downloads

The Coywolf Files plugin for WordPress, on EmDash. Add a **File download** block to any entry and visitors get a download card: a colored file-type badge, the file name, a "PDF · 2.4 MB · Uploaded Mar 4, 2026" line, a Download button, and a Copy link button.

- **Block**: pick a file from the Media Library or from large uploads, then give it a title and description for that placement. Toggles show or hide the icon, description, meta line, Download, and Copy link. The card is server-rendered, scoped (`cw-file`), follows light/dark (or a fixed scheme), and ships one small script for Copy link (clipboard, checkmark, screen-reader announcement).
- **Download URLs**: `/download/<id>/<file name>`, served by the pack middleware. Files stream from R2 with `Content-Disposition: attachment`, the right `Content-Type`, `Content-Length`, `ETag`, conditional requests, and single byte ranges with `If-Range` (resumable downloads; a request for several ranges gets the whole file). Or set a public bucket / CDN URL and downloads redirect there.
- **Files page** (**Plugins → Files**): every file used in a File download block plus every large upload, with type, size, upload date, downloads, and the entries that use it. Search, In use / Unused filters, copy link, delete, and **Export CSV** (every file with its full download URL, size, download count, last download, and the entries that use it). Deleting a large upload removes the object from R2; the page lists the entries that still use it (their blocks then render nothing). Media Library files are deleted in the Media Library.
- **Large uploads**: files of any type and size (EmDash's own uploads stop at 50 MB and images, video, audio, and PDF) go straight from the browser to R2 in 8 MB+ parts, four at a time, with progress, retries, and Cancel. The Worker only signs URLs (AWS Signature V4 with Web Crypto, no AWS SDK).

### Feature switches

| Feature | Default | What it does |
| --- | --- | --- |
| `files` | off | The block, download URLs, and the Files page |
| `files.counts` | off | Count downloads (batched D1 writes after the response) |
| `files.largeUploads` | off | Direct-to-R2 uploads (needs the settings below and a CORS rule) |

### Setup

1. Turn on **File Downloads** under **Plugins → Coywolf Pack**. The middleware from the Redirects setup (`coywolfPack()`) serves the download URLs; nothing else to add.
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

Files are stored as `files/<id>/<name>` with their metadata in plugin storage. Files moved from Coywolf Files for WordPress keep their 20-character WordPress id and object key (see [Migrating from WordPress](#migrating-from-wordpress)). The pack calls only `<account>.r2.cloudflarestorage.com`.

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

- Languages: Prism names used by Code Block Enhancer for WordPress work too (`markup` is HTML, `svg` and `mathml` are XML). EmDash's editor list (Astro, Svelte and Vue are highlighted as HTML, MDX as Markdown, TOML as INI) plus highlight.js's common grammars. Unknown languages, blocks over 30,000 characters and blocks with any line over 2,000 characters are shown as plain text (highlight.js slows sharply on long lines). Rendered blocks are cached in memory (200 per Worker isolate), so repeat page views don't re-highlight.
- Theme CSS is generated from highlight.js's own stylesheets (BSD-3-Clause, each theme's original credits kept) by `node scripts/gen-code-themes.mjs`.
- Tests: `node --test src/codeBlocks/render.test.ts`.

## Schema & Social

The structured data and social tags from Coywolf SEO for WordPress, configured on **Plugins → Schema**. Everything is off until you turn it on under **Plugins → Coywolf Pack → Schema & Social**:

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

### Videos in the graph

With the graph on, embedded videos are VideoObject nodes inside it, linked from the Article (or WebPage) as `video`: videos from the Videos module (when Video schema is on) and any a theme passes on the page context:

```astro
---
const page = { ...createPublicPageContext({ /* … */ }), coywolf: { videos: [
	{ name, description, thumbnailUrl, embedUrl, contentUrl, uploadDate, duration: "PT18S" },
] } };
---
<EmDashHead page={page} />
```

Theme videos are validated (absolute http(s) URLs, ISO 8601 duration) and de-duplicated by embed or content URL. When the graph is on, the Videos module doesn't print separate VideoObject blocks.

## Search

EmDash has full-text search built in: SQLite FTS5 with BM25 ranking, English stemming, prefix matching, highlighted snippets, a public API (`/_emdash/api/search`), and a `LiveSearch` component. This module adds what it leaves out. Turn on **Search** and its parts on the Coywolf Pack page. Search is off by default; once it's on, **Live results** is on too, and the other parts are off until you turn them on.

- **Search settings** (`search.settings`): a **Search** admin page to choose which collections are searchable, set field weights, pick the tokenizer (English stemming, exact words, or trigram substrings), and rebuild indexes with a progress readout and per-collection entry counts. It calls EmDash's own search API, so it needs EmDash's `search:manage` permission (admins). Fields are made searchable in each collection's schema.
- **Live results** (`search.live`, on by default with Search): matching entries in a dropdown as visitors type into the site's search box, like the Coywolf Search WordPress plugin. See [Live results](#live-results).
- **Search box** (`search.box`): a `SearchBox` component with as-you-type suggestions while **Live results** is on (titles first, then full text, with excerpts), arrow keys, Enter and Escape, a clear button, content-type labels, highlighted matches, screen-reader announcements, and a fade that respects reduced motion. When nothing matches every word, it shows results for any of the words, ranked by how many they contain. Without JavaScript it's a plain search form that submits to your search page.
- **Search rate limit** (`search.rateLimit`): limits each visitor to 120 searches a minute (configurable) on EmDash's public search and suggestion endpoints and the pack's search and live results routes, answering `429` with `Retry-After`. Visitors are keyed by a salted hash of their IP address, never the address itself.

### Live results

With **Live results** on, every public page gets a small inline script (about 14 KB, 4.5 KB compressed, at the end of the body via EmDash's page fragments, so the layout needs `<EmDashBodyEnd>`). It attaches to any GET form with a search field (`type="search"`, or a field named `s` or `q`), so a theme's own search form works as is; the pack's `SearchBox` has the same dropdown built in. Pages without a search form do nothing with it, and its styles are added only when a form is found.

- From 2 characters, 200 ms after the last keystroke, it shows up to 8 entries: title matches first, then full-text matches (with the any-word fallback). Each row has the title, with the typed words underlined, and an excerpt of about 180 characters around the first match, with the matches in bold and "…" where it was cut. A final **View all results** row opens the search page, the same URL the form submits.
- The first result is selected as results appear, so Enter opens it. Arrow keys move (wrapping, and through View all results), Escape closes the list and a second Escape clears the field, Tab or a click elsewhere closes it, and submitting the form searches as before. Results are real links, so middle-click and "open in new tab" work.
- Accessible as an ARIA combobox: `role="combobox"` with `aria-expanded`, `aria-controls` and `aria-activedescendant` on the field, a `listbox` of `option`s, and a polite live region announcing the result count (with a one-time keyboard hint). A clear (×) button sits inside the field for pointer and touch; Escape does the same from the keyboard. Forced colors are respected, and the fade is skipped for reduced motion.
- It takes the theme's font and text color from the form and its background from the nearest opaque ancestor, and tints with `currentColor`, so it fits light and dark themes without configuration.
- In-flight requests are cancelled as you type, answers are cached per query for the page view, and a slow earlier answer never replaces a newer one. Without JavaScript the form works exactly as before.

Results come from `GET /_emdash/api/plugins/coywolf-pack/search/live?q=…` (optional `limit` up to 20, `collections`, `locale`): published entries only, each with `title`, `titleHtml`, `url`, `type` and `snippet`. `titleHtml` and `snippet` are escaped HTML whose only tags are `<mark>`. Excerpts come from the text EmDash indexed (the searchable fields other than the title). Responses are cached for 60 seconds, and **Search rate limit** covers the route.

Tune it in `astro.config.mjs` (defaults shown):

```js
coywolfPlugin({ search: { live: { limit: 8, minChars: 2, debounce: 200, enterOpensTop: true } } });
```

`enterOpensTop: false` leaves nothing selected until the visitor arrows to a result, so Enter runs a full search.

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

Suggestions come from the live results route (above); with **Live results** off the SearchBox is a plain search form with a clear button. `GET /_emdash/api/plugins/coywolf-pack/search/query?q=…&mode=suggest` still returns EmDash's results plus each entry's URL (from the collection's URL pattern) and type label. Use the same OR fallback on your search page:

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

For a hard limit that never reaches your Worker, use a Cloudflare WAF rate limiting rule instead of (or as well as) this feature. The free plan includes one: **Security → WAF → Rate limiting rules**, match `URI Path starts with /_emdash/api/search` or `URI Path starts with /_emdash/api/plugins/coywolf-pack/search/`, counted per IP, for example 60 requests per 10 seconds with a 10-second block.

## AI Enrichment

Ported from Coywolf SEO's AI features, with the same prompts and validation:

- **Entities for schema** (`ai.entities`). The model lists the people, organizations, places, and things a page is about, without identifiers. Each name is looked up on Wikidata (`wbsearchentities`), and only items whose label or alias is that name (ignoring case, accents, and punctuation) count. When several match, the model may only pick one of them. Each chosen item's `instance of` (P31) claims are then checked: disambiguation pages are dropped, a Person must be human, an Organization or Place can't be a creative work (the album instead of the band), and an Organization can't be a place. The JSON-LD `name` is Wikidata's label. The result is stored per entry as Schema.org `about` (main subjects) and `mentions`, each with `sameAs` links to Wikidata, Wikipedia, and the official website (P856) when there is one. Coywolf's Schema module reads them with `getEntryEntities(ctx | db, collection, id)` from `src/ai/entities.ts`.
- **Output entities on their own** (`ai.entitiesStandalone`). Adds the entities to the page's JSON-LD as a `WebPage` node (same `@id` as EmDash's `mainEntityOfPage`). Only for sites that don't use Coywolf Schema.
- **Meta descriptions** (`ai.descriptions`). Writes a description (under 155 characters, no clickbait) for published entries in SEO-enabled collections that don't have one. By default they're suggestions you edit and apply on the AI page; or have empty descriptions filled automatically. Either way it writes only EmDash's SEO panel field and never replaces a description someone wrote unless you choose **Replace**.
- **Image text** (`ai.imageText`). Writes alt text (and, if you turn it on, captions) for images on upload and in bulk, with accessibility-first prompts. Alt text and captions people wrote are kept unless you turn on overwrite. EmDash media has no title or description fields, so titles are shown on the AI page for reference only.

All four are off by default, under the **AI Enrichment** switch on the Coywolf Pack page.

### How it runs

Saving, publishing, or uploading never waits on AI: hooks only add the entry or image to a queue (after a short wait, so a burst of saves becomes one job, and only when the entry's text actually changed). A scheduled job works through the queue every two minutes, a few items at a time (**Items per scheduled run**), and stops for the day at **Max model calls per day** (default 200; an entry costs up to three calls, an image one). Each run also stays under 40 outbound requests (model calls plus Wikidata lookups), so it fits the Workers Free plan's subrequest limit; entries and images take turns, so a backlog of one doesn't hold up the other. Failed items are retried after 5 and 20 minutes, then marked as errors; a retry reuses the model output it already paid for. Deleting an entry removes its analysis. **Run bulk** on the AI page queues every published entry (skipping unchanged ones) or every image without alt text. The AI page also has a connection test, the queue status, suggestions to review, the analyzed entities (with **Export CSV**: one row per entity with its Wikidata, Wikipedia and website links, plus each entry's AI description), and a 30-day usage log with token counts.

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

Help search engines and AI agents find your content. Ported from Coywolf SEO for WordPress. Everything is off until you turn it on under **Plugins → Coywolf Pack**: the **Discovery** switch, then any of its three parts. Settings and status are under **Plugins → Coywolf Pack → Discovery**.

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
- **Export CSV**: every link matching the current filters (all pages), with its status, HTTP code, final URL, the entries that use it, and their anchor text. Filter by **Broken** first for a list to hand to whoever fixes links. Cells that look like spreadsheet formulas are prefixed with an apostrophe.
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
3. Turn on **Videos** (and any sub-features) under **Plugins → Coywolf Pack**, open the **Videos** page, and click **Test connection**. Then **Rebuild embed index** once.
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

Manage `robots.txt` in plain English instead of a text box. The page opens with a one-paragraph summary of the whole file (**Search engines can crawl everything. AI training crawlers are blocked from the whole site.**), then three tabs:

- **Rules**: each rule as a sentence (“Block AI training crawlers (10) from the /private/ section and everything in it”), with an on/off switch, Edit (the same guided dialog), Duplicate and Delete. Order doesn't matter: crawlers follow the most specific matching line, and the file is written most-specific-first so older top-to-bottom crawlers agree. Below the list: a URL tester (**Can GPTBot fetch /2026/my-post/?**) and **What's being served**, the live file with Copy and Download, plus EmDash's original file for reference.
- **Bots**: the crawler directory (about 700 bots) with search and filters for category, purpose, operator, verification status and “used in rules”. Mark a bot verified (source URL and note, stored with the date and your name), rename it (the token never changes), add bots the directory lacks (token checked against `[A-Za-z0-9._-]+`, with a purpose), edit or delete them, and sync from Cloudflare Radar.
- **Settings and history**: keep EmDash's admin private, keep media crawlable, “crawlers named in a rule also keep the rules for all crawlers”, sitemaps, rule-name comments, Extra lines (for experts), the last 20 saved versions with Restore, **Reset to EmDash's original**, and **Export rules** / **Import rules…**: the rules and settings as a JSON file, to keep a copy or move them to another site. An import goes through the same checks as any change (with a confirmation listing the effects), replaces the current rules and settings, and keeps the current version in history.

**Templates** (header) replace the rule list in one click, through the same checks: *Block AI training, allow AI search*, *Allow everything*, *Block everything except search engines*.

### Taking over from EmDash

Turning the feature on takes over seamlessly. The first `/robots.txt` request or the first visit to the page (whichever comes first) converts the robots.txt EmDash was serving (its SEO setting, or its built-in default) into rules: groups become rules (identical lines for several bots become one rule, and known crawler groups are recognized), `Sitemap:` lines become sitemap settings, other lines (Crawl-delay, Content-Signal…) become Extra lines with their `User-agent` lines. The import is checked: for every crawler named in either file plus a few well-known ones and a stand-in for “any other crawler”, and every path the files' lines target, both files must give the same allow/block verdict (Google's matcher). If no combination of settings reproduces the file exactly, the original is kept as Extra lines, so crawlers always see the same rules. The one deliberate change: media in EmDash's library (`/_emdash/api/media/`) is opened to crawlers so images can appear in image search, and the summary under **What's being served** says so. The import is saved with an insert-if-absent, so concurrent first requests can't import twice. Turning the feature off serves EmDash's robots.txt again and keeps your rules for next time.

### Adding a rule

**Add rule** opens a four-step dialog:

1. **What do you want to do?** Keep crawlers out, or let crawlers in.
2. **Which part of your site?** Everything · A section (with “also wherever this folder name appears deeper”) · One page (with “only this exact address”) · A kind of file (PDF, Word, spreadsheets, images, ZIP, video… or other extensions, optionally only inside a section) · Links with tracking or extra parameters (utm_…, ref, fbclid, gclid, session IDs, sort and filters, site search, any `?`, or one you name) · Advanced pattern. Paste any address from your site: it's trimmed to its path, encoded, and read (“We read this as the /recipes/ section”), with a one-click switch when another choice fits better. Your collections' sections are offered as chips. A live box shows addresses the rule **will match** and nearby ones it **won't**, from the real matcher.
3. **Which crawlers?** Everyone · Search engines · AI training · AI search and assistants · SEO tools · Pick specific bots (search, categories with tick-all, verified badges, or a token that isn't listed). Each preset lists its members. Presets are curated by **purpose** from the operator's own documentation (`purposes` in `src/robots/data/verified.json`, with source URLs), never by Radar category, and only include verified tokens; bots that only come from Radar never join a preset, while verified custom bots with a matching purpose do. AI training is GPTBot, ClaudeBot, Google-Extended, Applebot-Extended, CCBot, meta-externalagent, Bytespider, Amazonbot, MistralAI-Training and Webzio-Extended. Rules made from a preset follow it: when a preset changes, the rule is updated on the next page load, with a one-time note listing crawlers added and removed.
4. **Review**: consequences first (“Search engines can fetch this section. 10 AI training crawlers can't.”), **Except…** for allowed items inside a blocked area, the name and note (prefilled), **Try a URL**, the exact lines under **Show robots.txt lines**, and the checks.

### Checks

Every change is checked in the browser as you type and again on the server before saving. Errors block saving; warnings need “I understand, add it anyway”.

- **Errors**: invalid crawler tokens, exceptions outside the blocked area (or ones that reopen all of it), line breaks, control characters or `#` in a value, patterns not starting with `/` or `*`, values over 2,083 characters, bad extensions or parameter names, an exact duplicate of another rule, the same crawlers both allowed and blocked on the same path, and a failed self-check.
- **Warnings**: a block on a discovery file that's kept readable, an Allow that nothing blocks, a block already covered by a wider block (naming it), a rule for everyone that named crawlers won't follow (with “Also apply it to these crawlers”), naming a crawler that then ignores the rules for all crawlers (RFC 9309 group selection; with the setting off, offers to turn it on), search engines blocked from your pages, CSS/JavaScript/images that renderers need, the media library, the sitemap, opening EmDash's admin, and blocks that the “Keep media crawlable” setting overrides.
- **Notes**: an Allow inside a block (valid; explained), where a more specific rule still decides, a partial duplicate (with **Merge**), unknown or unverified tokens, and case-sensitive paths.
- **Self-check**: after generating the file, every rule's crawlers are tested on addresses the rule targets, and the parsed file must give the verdict the rules say; crawlers the rule doesn't name must get the same verdict with and without it. A failure names the rule, crawler, address and deciding line.

### Automatic lines and the sitemap

**Discovery files stay readable.** Any crawler that your rules would block from `/.well-known/` (security.txt, ai-plugin.json and future machine-discovery manifests), from `/llms.txt` while Discovery's llms.txt feature is on (`/llms-full.txt` holds your full text, so add it yourself if you want it), or from discovery paths you add, gets an `Allow` line for them. The Rules tab lists these as **Automatic** lines with the reason. Turn the allowance off, or add paths, under **Settings and history**. Feature switches are read when the file is generated (middleware and admin preview), the self-check confirms each allowance, and a rule that targets a discovery file gets a warning.

**List the site's sitemap** sits at the top of the Rules tab. It's on for new and imported setups. A saved choice to turn it off is kept (for example when you submit sitemaps in Search Console), with a small note you can dismiss.

### How the file is written

One group per set of crawlers that follow the same lines. With “keep the rules for all crawlers” on (the default), a named crawler's group also gets the general rules, except where its own rules cover the same addresses (so “block GPTBot from the whole site” beats a general Allow). Every crawler not blocked from the whole site gets `Allow: /_emdash/api/media/` and `Disallow: /_emdash/`. We serve the file rather than writing EmDash's **SEO → robots.txt** setting because that setting is capped at 5,000 characters and couldn't keep EmDash's lines in every group.

Extra lines that would block search engines or the whole site are flagged on the page (they don't block saving). If EmDash's robots.txt settings can't be read during the takeover, nothing is imported and EmDash's file keeps being served until a later request succeeds.

Rules saved before 0.7.0 keep working unchanged: the stored config is read with defaults for the new fields, and “keep the rules for all crawlers” is turned on only when that changes no verdict.

Feature switches: **Robots.txt Rules** (`robots`) and **Weekly crawler list from Cloudflare Radar** (`robots.radarSync`). Both default to off.

### Setup

Uses the same `coywolfPack()` middleware as Redirects, and the `DB` binding. A static `public/robots.txt` in the site would be served by Workers static assets before the Worker runs, so remove it. Rules are read at most once a minute per Worker isolate; history and bot changes live in plugin storage (`robots_history`, `robots_bot_overrides`), the dismissed sitemap note in KV; the response is cached for an hour (`Cache-Control: public, max-age=3600`).

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

Create a Cloudflare API token with **Account → Radar → Read** and either paste it into the setup card on the Robots.txt page's **Bots** tab (stored encrypted; it's also on the plugin's generic Settings page) or set it as a Worker secret:

```bash
npx wrangler secret put RADAR_API_TOKEN
```

The module declares `network:request` for `api.cloudflare.com` only.

## Reviews

The review box Coywolf uses on WordPress (Coywolf Custom Blocks' review block): a rating badge with "4.5 out of 5" under it, then **What I liked most** and **Could be better** lists side by side, stacking on narrow screens. It adds Review schema that Google can read for review snippets and product pros and cons.

- **Coywolf Review block** (slash menu → Content): item name, item type (the types Google accepts for reviews: Product, Software application, Book, Course, Movie, Game, Event, Recipe, Local business, Organization, and a few more), brand, item URL, item image (for schema only), book details (author, ISBN, publisher, genre, copyright year) and software details (operating systems, app category) for schema, rating (0–5 in tenths, e.g. 4.7), the two headings (defaults above), pros and cons (one per line), an optional summary or verdict, and the heading level (H2 by default, like WordPress). It's server-rendered plain HTML with no script. Its CSS is about 2 KB, inlined once per page before the first box, so nothing shifts.
- **Ratings** are picked from a menu of 5.0 down to 0.0 in steps of 0.1 (EmDash's number field only takes whole numbers). The badge and caption show the rating as stored ("4.7 out of 5", "5 out of 5"), and Review schema's `ratingValue` is the same number. Reviews saved before 0.11.0 with half steps keep working; saving the entry stores them in the new format (`"4"` becomes `"4.0"`) so the menu shows them.
- **Reviews page** (**Plugins → Coywolf Pack → Reviews**): the badge's accent color (default `#2C8452`; badge text is white), **Custom CSS**, and a live preview of a sample review, wide or at phone width. The preview runs in a sandboxed frame, so your CSS can't restyle the admin.
- **Accessible**: the box is a `<section>` labeled "Review of <item>". The badge number is hidden from screen readers, which read "Rated 4.5 out of 5" instead. The lists are real headings and lists.

| Feature | Default | What it adds |
| --- | --- | --- |
| `reviews` | off | The block on the site, and the Reviews page |
| `reviews.schema` | off | Review JSON-LD for each review, in Schema & Social's graph when it's on, otherwise one standalone script per review (`page:metadata`, ids `coywolf-review-N`) |

### Customizing the look

Every part has a stable class: `.cw-review` (the card), `__rating`, `__badge`, `__caption`, `__columns`, `__col` (plus `__pros` / `__cons`), `__heading`, `__list`, `__item` and `__summary`. Every design value is a CSS custom property. The built-in CSS only reads them, with fallbacks, so you can set them on `.cw-review`, on a wrapper, or on `:root`:

| Property | Default | |
| --- | --- | --- |
| `--cw-review-accent` | the Reviews page color | Badge background |
| `--cw-review-badge-color` | `#fff` | Badge text |
| `--cw-review-badge-size` / `-badge-padding` / `-badge-radius` | `3.5rem` / `.5rem 1rem` / `10%` | |
| `--cw-review-bg` / `--cw-review-bg-dark` | `#fff` / `#1d1f23` | Card background (light / dark); `--cw-review-bg` alone sets both |
| `--cw-review-border` | `1px solid` + the border color | Whole border shorthand (e.g. `0`); overrides the colors below |
| `--cw-review-border-color` / `--cw-review-border-color-dark` | `#dfe0e3` / `#3a3d44` | |
| `--cw-review-radius` / `-padding` / `-margin` | `12px` / `2rem 1rem` / `0 0 1.5rem` | |
| `--cw-review-color` / `-font` | `inherit` | Text color and font |
| `--cw-review-heading-color` / `-heading-size` / `-heading-transform` | `inherit` / `1.2rem` / `uppercase` | |
| `--cw-review-list-color` / `--cw-review-list-color-dark` / `-list-size` / `-list-style` | `#555` / `#c9ccd1` / `1rem` / `square` | `--cw-review-list-color` alone sets both |
| `--cw-review-caption-color` / `-caption-size` | `inherit` / `1rem` | The "4.5 out of 5" line |
| `--cw-review-gap` / `-column-gap` | `1rem 1.5rem` | Space between the badge and lists, and between the lists |
| `--cw-review-rating-width` | `7rem` | Badge column's minimum width |
| `--cw-review-stack-at` | `26rem` | Narrowest the lists area gets beside the badge before the badge moves above it |
| `--cw-review-column-min` | `13rem` | Narrowest a list column gets before the lists stack; `100%` keeps them in one column |

Light and dark colors use CSS `light-dark()`, so the box follows the page's own `color-scheme`: on a theme that declares `color-scheme: light dark` it turns dark with the page, and on a light-only theme (no `color-scheme`) it stays light whatever the visitor's system setting. The `-dark` properties are the dark half.

The layout uses flex and grid wrapping instead of a media query, so it adapts to the box's own width (a sidebar or a phone alike) and the "breakpoints" are the custom properties above.

Put overrides in **Custom CSS** on the Reviews page. It's added after the built-in styles on pages with a review, so it wins. Start every rule with `.cw-review` so it only reaches review boxes; it's printed as-is (not rewritten), with `</style`, `<!--` and `-->` removed and a 20 KB cap. For example, a crimson badge and one column:

```css
.cw-review {
  --cw-review-accent: #b22d47;
  --cw-review-column-min: 100%;
}
.cw-review .cw-review__heading { text-transform: none; }
```

### Review schema

With Schema & Social's graph on, each review joins the page's `@graph` like videos do. The reviews come from the entry's `coywolf-review` blocks (any Portable Text field), followed by any the theme passes as `page.coywolf.reviews`, de-duplicated by item type and name, up to 20.

- **Products** become a top-level `Product` (`<page>#review-N-item`, with name, `brand` as a `Brand`, url and image). The `Review` (`<page>#review-N`) is nested in it as `review`. Google reads pros and cons (`positiveNotes` / `negativeNotes`, each an `ItemList` of `ListItem`s with position and name) only from a Review nested in a Product, and a nested review needs no `itemReviewed`.
- **Other types** become a top-level `Review` with the item in `itemReviewed`. That's the shape Google's review-snippet docs show, and it avoids validating, say, an Event or SoftwareApplication as its own rich result.
- **Pros and cons** are emitted only for Product reviews with at least two statements in all (Google's minimum); they still show in the box either way.
- **Books and software** get their details on the item: a Book's `author` (Person), `isbn`, `publisher` (Organization), `genre` and `copyrightYear`; a SoftwareApplication's `operatingSystem` and `applicationCategory`.
- **Every review** has a `reviewRating` (`Rating`, `ratingValue`, `bestRating` 5, `worstRating` 0, because the scale starts at 0), the Article's author(s) as `author` (else the publisher), the graph's publisher, the Article's `datePublished`, `mainEntityOfPage` → the WebPage, and the summary as `reviewBody`. The item is added to the Article's (or WebPage's) `about`, alongside AI Enrichment's entities.
- **Not emitted**: reviews without an item name or a rating, and "self-serving" reviews, which Google ignores. Those are an Organization or Local business whose URL is on your own site or whose name is the publisher's.

With the graph off, each review is a standalone JSON-LD script in the same shape. The author is the page's byline name (else the site), and the publisher is the site. Some item types need more properties for their own rich results (an Event's date and location, for example). The block doesn't collect those, so validate important pages in Google's Rich Results Test. Google's product snippets focus on one product per page: several Product reviews on one page are all output, but Google may use only one of them.

### Legacy WordPress reviews

Themes that render imported WordPress review markers (`{ name, brand, rating, strengths, shortcomings }`, with the lists as `<ul>` HTML) can use the same box and schema:

```astro
---
import { Review, reviewFromAttrs } from "@coywolf/emdash/astro";
---
<Review attrs={markerAttrs} />   <!-- or <Review {...markerAttrs} /> -->
```

and pass the same reviews to the page context for schema:

```astro
---
const reviews = reviewMarkers(post.data.content).map(reviewFromAttrs); // your marker parser
const page = { ...createPublicPageContext({ /* … */ }), coywolf: { videos, reviews } };
---
<EmDashHead page={page} />
```

`reviewFromAttrs` reduces the `<li>` HTML to plain text (tags dropped, entities decoded) and maps the marker attributes to the block's fields. You can also pass `itemType`, `url`, `image` and `summary` attributes, and the WordPress book (`author`, `isbn`, `publisher`, `genre`, `copyright`) and software (`os`, `category`) fields. To turn imported markers into Coywolf Review blocks instead, see [Migrating from WordPress](#migrating-from-wordpress). `<Review>` isn't gated by the feature switch, because a theme that uses it has opted in, but it uses the Reviews page's accent and custom CSS. Schema still needs `reviews.schema`. Remove any review JSON-LD the theme prints itself.

`reviews: false` leaves the module out.

## Custom Blocks

Six editor blocks (slash menu → Content), each with its own switch, named after Coywolf's WordPress plugin, Custom Blocks. They're server-rendered plain HTML with no script, accessible (landmarks with names, native disclosure widgets, real quotations), and share one small stylesheet (under 5 KB) inlined once per page before the first block. They're rendered by the pack's components rather than stored as HTML, so EmDash's HTML sanitizer doesn't strip `<details>`, `<summary>`, `<aside>` or `<figure>`.

| Feature | Default | Block | Fields |
| --- | --- | --- | --- |
| `customBlocks` | off | (module switch; the Custom Blocks page) | |
| `customBlocks.note` | off | **Note**: a callout in an `<aside>` labeled by its title | Kind (Note, Editor's note, Tip, Warning), title (empty = the kind's name), hide title, title style (bold text or an H2–H4), text |
| `customBlocks.details` | off | **Details**: native `<details>`/`<summary>` | Style (Details, or Transcript: the hidden text sits in a tinted panel), summary (default "Details" / "Read the transcript"), hidden text, open when the page loads |
| `customBlocks.disclosure` | off | **Affiliate disclosure**: small, muted text in an `<aside>` labeled "Affiliate disclosure" | Disclosure (Affiliate links or Amazon Associates), wording for this page (optional; empty uses the site's) |
| `customBlocks.quote` | off | **Quote**: `<figure><blockquote cite>…</blockquote><figcaption><cite>…</cite></figcaption></figure>` | Quote, who said it, source URL (the `cite` attribute) |
| `customBlocks.testimonial` | off | **Testimonial**: `<figure><blockquote>…</blockquote><figcaption>` photo, name, title `</figcaption></figure>`; the quote sits in a speech bubble with the person below it | What they said, name, title, photo (media library), link for the name (e.g. a social profile), link for the title (e.g. their company) |
| `customBlocks.podcast` | off | **Podcast links**: a `<section>` labeled by its heading, with a list of links named by service (Apple Podcasts, Spotify, YouTube, Amazon Music, Overcast, Pocket Casts, RSS feed), each with a small line icon | Links (the site's podcast from the Custom Blocks page, or only this block's), heading (empty = the site's), a link per service |

**Text fields** are plain text: a blank line starts a new paragraph, a single line break is a line break, `[link text](https://…)` is a link and `**text**` is bold. Simple HTML works too, so imported WordPress content keeps its exact markup: links (`href`, `title`, `rel` limited to `nofollow`, `sponsored`, `ugc` and the like), bold, italics, `<code>`, `<abbr title>`, `<q cite>`, `<mark>`, `<sub>`/`<sup>`, lists, paragraphs, H2–H6, `<figure>` and `<img>`, and text styling in `style` (color, font size and weight, …). Everything else is dropped (its text stays), links are limited to http(s), mailto, tel and site-relative URLs, and tags left open are closed, so a block can't break the page around it. Titles, summaries and citations are one line (no paragraphs or block tags). A testimonial's name and title are plain text.

**Testimonials** have no schema: Google doesn't show review rich results for reviews a site collects and shows about itself, and a testimonial has no rating. The photo's alt text is empty because the name right next to it says who it is.

**Custom Blocks page** (**Plugins → Coywolf Pack → Custom Blocks**): the site's disclosure wording for affiliate links and for Amazon Associates (Amazon requires "As an Amazon Associate I earn from qualifying purchases."), an optional disclosure page linked after it ("Learn more" by default); the podcast's links (one per service; empty ones are left out), heading ("Subscribe to the podcast" by default), heading style (H2–H4 or bold text) and whether to show icons; and live previews of every block. A Podcast links block with no links shows nothing.

**Styling**: colors are mixed from the theme's text color (`currentColor`), so the blocks follow light and dark themes; notes add a hue per kind, a little stronger in dark mode. Override with the theme's CSS: `--cw-note-accent` on `.cw-note` (or `.cw-note--tip`, …), and the classes `.cw-note`, `__title`, `__body`; `.cw-details`, `--transcript`, `__summary`, `__body`; `.cw-disclosure`, `__text`, `__link`; `.cw-quote`, `__text`, `__caption`; `.cw-testimonial`, `__quote`, `__person`, `__photo`, `__name`, `__title`; `.cw-podcast`, `__title`, `__links`, `__link` (and `--apple`, `--spotify`, … per service), `__icon`.

**Renamed in 0.12.0**: this module was called Content Blocks. Its page moved from `/content-blocks` to `/custom-blocks` (the old address still opens it), and its feature ids from `contentBlocks*` to `customBlocks*`; saved switches carry over, and the block types (`coywolf-note`, `coywolf-details`, `coywolf-disclosure`, `coywolf-quote`) and the saved disclosure wording are unchanged.

`customBlocks: false` leaves the module out (`contentBlocks: false` still works).

## Migrating from WordPress

The **WordPress import** module (**Plugins → WordPress import**, off until you turn it on under **Plugins → Coywolf Pack**) moves content that used Coywolf's WordPress plugins into Coywolf Pack blocks.

### Why a prepare step

EmDash's importer converts Gutenberg with `@emdash-cms/gutenberg-to-portable-text`, which plugins can't extend. Blocks it doesn't know become an HTML block of their saved HTML, and blocks that save no HTML (self-closing blocks such as Coywolf Custom Blocks' review, Cloudflare Stream schema, blockquote, sidenote, transcript and disclosures, and Coywolf SEO's table of contents) are dropped without a trace. Heading ids are dropped too. So the export is prepared first: **Prepare the WordPress export** on the WordPress import page (in the browser; the file isn't uploaded), or from a checkout of this repository:

```bash
node scripts/wp-prepare.mjs export.xml export-prepared.xml
```

It rewrites those blocks into HTML blocks holding a marker (`<div data-coywolf-wp="…" data-coywolf-attrs="…">`), which EmDash keeps, and leaves everything else byte for byte. While WordPress import is on, every save (including each entry the importer creates) turns markers into native blocks. Entries already on the site are converted with **Convert imported content** (dry run first). Both are idempotent.

### What converts

| WordPress block | Becomes | Notes |
| --- | --- | --- |
| `coywolf-custom-blocks/cloudflare-stream` + the Custom HTML embed before it | Coywolf Video | Name, description, length (hours/minutes/seconds), player options from the iframe URL (autoplay, loop, muted, controls, preload, poster frame), size from the wrapper (padding-top %, max-width). Wrappers whose iframe was stripped on WordPress get their video back. |
| Custom HTML with only a Stream iframe or `<stream>` element | Coywolf Video | Same options; a `<figcaption>` becomes the shown description |
| `coywolf/video` (Video Manager) | Coywolf Video | Every block option; options the block didn't set take Video Manager's settings (paste them on the import page; the plugin's defaults otherwise) |
| `coywolf-custom-blocks/review` | Coywolf Review | Item type from the Schema Type field, else Book when it has book details, Software application when it has operating systems or a category, else Product (WordPress picked it by category). Book author, ISBN, publisher, genre, copyright year and link, and software operating systems and category, go into the new schema fields. |
| `coywolf-seo/table-of-contents` | Table of Contents | Levels, list style (disc → bulleted, decimal → numbered), title, show title, collapsible/collapsed |
| Heading `id`s | the heading's anchor | Kept as written (no `jump-` prefix), so old `#links` work. Turn on Headings & TOC's anchors. |
| `coywolf/file` (Coywolf Files) | File download | Keeps the WordPress file id; see "Files" below |
| `code` (Code Block Enhancer) | EmDash code block | Language kept (Prism's `markup` → `html`); bold markup and `&#91;` inside code are cleaned |
| `coywolf-custom-blocks/sidenote`, `editorsnote` | Note | The text exactly as written (links, bold, `rel="sponsored"`, …). Sidenotes are Note-kind with WordPress's title "📌 Sidenote", editor's notes Editor's-note-kind with "📝 Editor's Note", both as H2 like WordPress. |
| `coywolf-custom-blocks/transcript`, `accordion`, core `details` | Details | Summary (the transcript's default was "Read the audio transcript") and the hidden HTML exactly; transcripts use the Transcript style; core Details keeps "open by default" |
| `coywolf-custom-blocks/blockquote` | Quote | The quote (paragraphs and lists), who said it (with its link) and the source URL from the `cite` field. A pack block rather than EmDash's quote: that's a single paragraph with no citation or source URL. |
| `coywolf-custom-blocks/ftc`, `genesis-custom-blocks/disclosure` / `amazon` | Affiliate disclosure (affiliate / Amazon Associates) | They had no text of their own (the theme printed it), so they use the wording on the Custom Blocks page. Set it to your old wording. |
| `coywolf-custom-blocks/testimonial` | Testimonial | Name, title, quote, Social URL (the name's link) and Work URL (the title's link) exactly. The headshot keeps the URL from the export's attachments (WordPress's uploads URL): pick it from the media library on the block, or redirect `/wp-content/uploads/`, before WordPress goes away. |
| `coywolf-custom-blocks/podcast-rss` | Podcast links (the site's links) | The WordPress block had no fields: its template printed the show's links. Set them once on the Custom Blocks page (for coywolf.com: heading "Subscribe to Coywolf Podcast", Apple Podcasts, Spotify, Amazon Music and the RSS feed; Google Podcasts has shut down). |
| Yoast related links | HTML block | The markup WordPress rendered |
| `gravityforms/form` | empty marker (`gravity-form`, with `formId`) | Rebuild the form (EmDash forms plugin or theme) |
| `coywolf-custom-blocks/newsletter` | removed | Rendered nothing on WordPress |

Everything else goes through EmDash's importer unchanged. wellbeing.io's older `data-wb-block` markers (`cloudflare-stream`, `review`) convert too.

Notes, details, quotes, disclosures, testimonials and podcast links convert only while their Custom Blocks switch is on. Otherwise their markers stay HTML blocks (with WordPress's markup, so the text shows) and convert when you turn the block on and run **Convert imported content** again. Markers from 0.10.0 and 0.11.0 (which held only that markup, or were an empty podcast placeholder) convert too. Ratings import exactly (4.7 stays 4.7).

### Guest authors

The Coywolf Guest Author plugin stores one guest per post in post meta (`_guest_author` name, `_guest_author_url`, `_guest_author_bio`, `_guest_author_avatar_id`), with no WordPress user, and swaps the byline on the page. EmDash's importer credits those posts to their WordPress user instead. Plugins can only read EmDash bylines, so **Guest author bylines** (step 4 on the WordPress import page) does it from your browser with EmDash's own byline and content API, as you:

1. It reads the guests from the export (the one prepared in step 1, or choose it again) and groups them by name.
2. **Dry run** looks up, for each guest, a byline with the same name, the avatar image in the media library (by file name; present when the importer imported the attachments), and each imported post (by its WordPress slug) with its current byline.
3. **Create bylines and credit posts** creates a guest byline (name, website, bio as plain text, avatar) where none exists, and sets it as the post's only byline, replacing the WordPress user. Posts already credited are skipped, so running it again changes nothing. You need permission to manage bylines and edit any entry.

Schema & Social's author Person and Review schema then name the guest (with their website as `url`, bio as `description` and avatar as `image`, and Author profiles on the Schema page lists them). What stays manual: an avatar that isn't in the media library (upload it, then pick it on the byline under **Bylines**); a post whose slug changed on import ("Not found" in the dry run; credit it in the editor); and guest bylines get the author-page URL pattern in schema like any byline, so set the byline's website if the theme has no page for guests.

### Category and page parents

EmDash's importer creates every category at the top level and drops each page's parent, so WordPress URLs with parent categories (`/news/seo/a-post/`) or parent pages (`/apps/coywolf-seo/`) are lost. **Category and page parents** (step 5 on the WordPress import page) puts them back, from your browser:

1. It reads the categories (`<wp:category>` with `<wp:category_parent>`) and pages (`<wp:post_parent>`) from the export (the one prepared in step 1, or choose it again).
2. **Dry run** lists each category that had a parent in WordPress with its parent on the site now: "Set to …", "Change to …" (the site has a different parent), "Already set", or why it can't be set (the category or its parent isn't on the site).
3. **Set category parents** sets them through EmDash's own taxonomy API (`PUT /_emdash/api/taxonomies/category/terms/<slug>`), as you, parents first. Categories already right are skipped, so running it again changes nothing. You need permission to manage taxonomies.

EmDash pages have no parent, so the step shows a ready-to-paste `pageParents` option for `coywolfPlugin()` instead (use it with `{pagepath}`, see [Content URLs](#content-urls)). `node scripts/wp-prepare.mjs` prints the same `pageParents` option, plus a `termParents` option you can use until the category parents are set.

### Order of operations

1. Install this version and turn on, under **Plugins → Coywolf Pack**: **WordPress import**, **Videos** (and Video schema, sitemap, plays and likes as wanted), **Reviews** and **Review schema**, **Custom Blocks** with the Note, Details, Affiliate disclosure, Quote, Testimonial and Podcast links blocks, **Headings & TOC** with **Heading anchors** and **Table of Contents block**, **File Downloads**, and **Code Blocks**. Set your disclosure wording and podcast links on the Custom Blocks page. Connect Stream on the Videos page (same account) or at least set the customer subdomain.
2. On **WordPress import**, paste Video Manager's and Coywolf Files' settings (step 2) so converted blocks keep the site-wide choices.
3. Export from WordPress (**Tools → Export → All content**), prepare the file (step 1), and import the prepared file under **Settings → Import**.
4. Run **Convert imported content → Dry run**. It should list nothing left to convert; if the module (or a block) was off during the import, run **Convert**.
5. Guest authors: run **Guest author bylines → Dry run**, then **Create bylines and credit posts** (step 4).
6. Parents: run **Category and page parents → Dry run**, then **Set category parents** (step 5). Paste the `pageParents` it shows into `coywolfPlugin()`, and use `{termpath:category}` and `{pagepath}` in `urls` if the theme serves WordPress's hierarchical URLs.
7. Files: copy each Coywolf Files object into the bucket bound as `FILES` (or `MEDIA`) under the same key (`coywolf-files/YYYY/MM/<id>-<name>`), paste `wp db query "SELECT file_id, object_key, filename, mime, size, downloads, created FROM wp_coywolf_files"` into step 6, and set **Files → Settings → Download URL base** to WordPress's link base (`coywolf-file` by default) so old download links keep working. Download counts carry over.
8. Videos: paste the output of `wp option get coywolf_cvm_descriptions --format=json` (and the same for `coywolf_cvm_posters` and `coywolf_cvm_downloads`) into step 7 for per-video descriptions, posters and MP4 links. On the Videos page, **Refresh** the library (with the token) and **Rebuild embed index**.
9. Redirects: import Coywolf SEO's redirects (see Redirects) and add a rule for `/wp-content/uploads/(.*)` if media URLs moved.
10. Run the Headings & TOC, Schema and Videos checks on a few entries (Rich Results Test for a review and a video page), then turn **WordPress import** off.

Without a Stream token, converted videos still play and have VideoObject schema: the name, length, upload date and size come from WordPress and are stored as the video's details until Stream's own data replaces them. Captions, plays from Stream, MP4 links found via the API, and the library listing need the token.

## Development

```bash
npx tsc --noEmit -p .        # typecheck
node --test test/*.test.mjs  # unit tests (Node 22.15+; runs the TypeScript sources directly)
```

## License

MIT
