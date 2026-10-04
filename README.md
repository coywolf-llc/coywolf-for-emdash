# Coywolf Pack for EmDash

One plugin with [Coywolf](https://coywolf.com)'s features for [EmDash](https://emdashcms.com) sites on Cloudflare: the things Coywolf's WordPress plugins do that EmDash doesn't do natively. Enable only the modules you want.

| Module | What it does |
| --- | --- |
| **Backups** | Full backups (D1 database + R2 media), rewind with undo, restore to a new database, missing-media restore |
| **Redirects** | Redirect manager for what EmDash's built-in Redirects can't handle: external destinations and file paths |
| **Headings & TOC** | Linkable headings (`#jump-…` anchors), a Table of Contents block, and a Breadcrumbs block and theme component |
| **Code Blocks** | Server-side syntax highlighting, themes, language label, copy button and line numbers for code blocks |

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

## Code Blocks

A port of Coywolf Code Block Enhancer. It replaces the site renderer for EmDash's built-in code block (the editor's language picker is unchanged) with one that highlights code **on the server** using highlight.js grammars (via lowlight, which EmDash already ships). Visitors download no highlighting script.

- **Themes** (**Plugins → Code Blocks**, with a live preview): Coywolf Auto (light/dark by system), Coywolf Always light, Coywolf Always dark, four light/dark pairs that follow the system setting (GitHub, Atom One, A11y, Tokyo Night), and 19 popular highlight.js themes (GitHub, GitHub Dark, Monokai, Nord, Dracula, Solarized, Visual Studio, Xcode, Night Owl and more). The theme is the `codeBlocksTheme` setting.
- **Language label**, **Copy button** and **Line numbers** are sub-features. The copy button follows the WordPress plugin's accessible pattern: a labeled button, a polite live region that announces "Copied to clipboard", a two-second confirmation, and no animation for visitors who prefer reduced motion. Line numbers are drawn with CSS, so they're never selected or copied. A block's `filename`, if set, is shown in its header.
- **Page weight**: the layout CSS (about 2 KB), the active theme's CSS (1–4 KB) and, with the copy button on, one small inline script (under 1 KB) are inlined once per page by the first code block. Pages without code blocks get nothing, and no external requests are made.

Feature switches: `codeBlocks` (main), `codeBlocks.label`, `codeBlocks.copy`, `codeBlocks.lineNumbers`, all off by default. While `codeBlocks` is off, code blocks render exactly as EmDash's built-in renderer does.

### Setup

Nothing beyond the plugin itself: the block renderer is registered through the plugin's `componentsEntry`, so it applies wherever the site renders Portable Text with EmDash's `<PortableText>`. It reads the theme and switches from the site's D1 database (`DB`), cached for 30 seconds per Worker isolate.

### Notes

- Languages: EmDash's editor list (Astro, Svelte and Vue are highlighted as HTML, MDX as Markdown, TOML as INI) plus highlight.js's common grammars. Unknown languages, and blocks over 100,000 characters, are shown as plain text.
- Theme CSS is generated from highlight.js's own stylesheets (BSD-3-Clause, each theme's original credits kept) by `node scripts/gen-code-themes.mjs`.
- Tests: `node --test src/codeBlocks/render.test.ts`.

## License

MIT
