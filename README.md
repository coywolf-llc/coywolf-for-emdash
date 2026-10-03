# Coywolf Pack for EmDash

One plugin with [Coywolf](https://coywolf.com)'s features for [EmDash](https://emdashcms.com) sites on Cloudflare: the things Coywolf's WordPress plugins do that EmDash doesn't do natively. Enable only the modules you want.

| Module | What it does |
| --- | --- |
| **Backups** | Full backups (D1 database + R2 media), rewind with undo, restore to a new database, missing-media restore |
| **Redirects** | Redirect manager for what EmDash's built-in Redirects can't handle: external destinations and file paths |

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

## License

MIT
