# KomaYomi Online

A static, browser-only edition of [KomaYomi](https://github.com/PayayaKamo/KomaYomi): open a `.mnproj` project, read a chapter in several languages side by side, draw panels, write page and panel notes, and export the result — no server, no install, nothing uploaded.

## Try it

**<https://payayakamo.github.io/KomaYomi-online/>**

Click **Open the demo project** on the landing page to load the three-volume, three-language sample with notes, annotations and note pins. The roughly 68 MB archive is not part of the site: it is downloaded on demand from GitHub, verified (size, ZIP signature, SHA-256) and cached in IndexedDB, so repeat visits and offline use skip the download. You can also open your own `.mnproj` file.

## Run it locally

```bash
pnpm install
pnpm dev        # http://localhost:5173/KomaYomi-online/
```

Other scripts: `pnpm build` (type-check + static build into `dist/`), `pnpm preview` (serve the production build).

## The KomaYomi ecosystem

KomaYomi ships in four forms that share the same `.mnproj` project format, so a project opened in one form can be exported and opened in another:

| Repository | Role |
| --- | --- |
| [KomaYomi](https://github.com/PayayaKamo/KomaYomi) | The full desktop edition (Electron + local server): folder scanning, automatic panel detection, backups, storage providers, plugins. |
| [KomaYomi-online](https://github.com/PayayaKamo/KomaYomi-online) | This repository — a pure browser edition. No server, no install; a deliberate subset of the desktop edition. |
| [KomaYomi-mobile](https://github.com/PayayaKamo/KomaYomi-mobile) | The React Native mobile edition for reading on phones and tablets. |
| [KomaYomi-docs](https://github.com/PayayaKamo/KomaYomi-docs) | The documentation site, generated automatically by CI from the desktop repository. |

## What it can do

- **Open `.mnproj` projects** — both `packaged` projects (images inside the archive) and `reference` projects (paths only; attach the original image folder during import to see the pages).
- **Browse** volumes, chapters and pages from the project inventory.
- **Compare view** — several languages side by side, zoom and alignment helpers.
- **Original view** — the untouched page image per language, with wheel zoom, drag and linked panes.
- **Panel detail** — step through panels and pages, with the crop, notes and annotations for one panel.
- **Panel workbench** — inspect, move, resize, add and delete panels by hand; edit coordinates; reorder and group panels.
- **Notes** — page and panel notes, tags, Markdown, links, annotations.
- **Read mode** — a read-only switch that hides and blocks every editing path.
- **Export** — a single self-contained HTML file (optionally with print-on-open CSS) or PNG of the whole page / one panel / a three-language collage.
- **Save** the open project back to `.mnproj`, packaged (with images) or reference (structure and notes only).

## Details

### How data is stored

- **Everything stays in the browser.** Project data lives in IndexedDB, images are object URLs, and exports are downloads. Every change is written back into the same `.mnproj` document model the desktop and mobile editions use.
- **Your data lives in this browser.** Notes and panel edits are written to IndexedDB. Clearing site data, using a different browser or a private window means starting over.
- **Download the project before switching devices.** The File menu (or the project dialog) can export a packaged `.mnproj` that you can open anywhere.
- **Reference projects need their images attached.** A reference `.mnproj` only records where the images were; pick that folder in the import dialog to link the pages, otherwise pages appear with a missing-image placeholder.

### What the online edition can't do

- **No folder scanning or library building from disk** — those need filesystem access; the UI hides them.
- **No automatic panel detection** — draw panels by hand instead.
- **No WebDAV, backups, scheduled jobs, plugins or template exchange files** — all local-only.
- **No disk storage** — projects live in this browser's IndexedDB rather than on your disk.
- **Read mode is a front-end guard, not a security boundary** — it blocks every write path in the UI, but there is no server to enforce it.

### Repository layout

```text
src/                 React UI (copied from KomaYomi, trimmed for the static edition)
  api.ts             API-shaped facade implemented entirely in the browser
  static/db.ts       IndexedDB stores: workspace metadata, page documents, images
  static/projectStore.ts  .mnproj import/export, library building, object URLs
  static/exportHtml.ts    self-contained HTML export
  components/        Sidebar, CompareTab, PanelsTab, NotesPanel, dialogs…
shared/              Types, schema migrations, Markdown and panel-ordering helpers
```

The UI is the same as the local app; only `src/api.ts` is replaced with a static implementation. Unsupported endpoints raise `OnlineUnsupportedError`, and the corresponding menu items are removed rather than failing at click time.

### Deployment

`.github/workflows/deploy.yml` builds on every push to `main` and publishes `dist` with the official GitHub Pages actions. One-time setup in the repository: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

The build is configured for the `/KomaYomi-online/` sub-path in `vite.config.ts`, which is what GitHub Pages uses for a project site. Change `base` there if you deploy under a different path or domain.

### License

Released under the [MIT License](LICENSE), same as [KomaYomi](https://github.com/PayayaKamo/KomaYomi).
