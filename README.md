# KomaYomi Online

A static, browser-only edition of [KomaYomi](https://github.com/PayayaKamo/KomaYomi) — open a `.mnproj` project, read a chapter in several languages side by side, draw panels, write page and panel notes, and export the result. Everything runs in the browser; there is no server and nothing is uploaded.

**Live:** <https://payayakamo.github.io/KomaYomi-online/>

Try it in two clicks: open the site, click **Sample project**, then **Open**. The bundled demo uses original, programmatically drawn artwork.

## What works

- **Open `.mnproj` projects** — both `packaged` projects (images inside the archive) and `reference` projects (paths only; attach the original image folder during import to see the pages).
- **Browse** volumes, chapters and pages from the project inventory.
- **Compare view** — several languages side by side, zoom and alignment helpers.
- **Panel workbench** — inspect, move, resize, add and delete panels by hand; edit coordinates; reorder and group panels.
- **Notes** — page and panel notes, tags, Markdown, links, annotations.
- **Export** — a single self-contained HTML file (optionally with print-on-open CSS) or PNG of the whole page / one panel / a three-language collage.
- **Save** the open project back to `.mnproj`, packaged (with images) or reference (structure and notes only).

## Boundaries of the online edition

| Capability | Online | Local edition |
| --- | --- | --- |
| Open `.mnproj` | Yes | Yes |
| Scan a manga folder / build a library from disk | No | Yes |
| Automatic panel detection | No (draw panels by hand) | Yes |
| WebDAV, backups, scheduled jobs, plugins | No | Yes |
| Template exchange files | No | Yes |
| Project storage | This browser's IndexedDB | Your disk |

- **Your data lives in this browser.** Notes and panel edits are written to IndexedDB. Clearing site data, using a different browser or a private window means starting over.
- **Always download the project before switching devices.** The File menu (or the project dialog) can export a packaged `.mnproj` that you can open anywhere.
- **No directory scanning and no automatic panel detection.** Those need filesystem access and a server-side worker; the UI hides or labels them as local-only.
- **Reference projects need their images attached.** A reference `.mnproj` only records where the images were; pick that folder in the import dialog to link the pages, otherwise pages appear with a missing-image placeholder.

## Development

```bash
pnpm install
pnpm dev        # http://localhost:5173/KomaYomi-online/
pnpm build      # type-check + static build into dist/
pnpm preview    # serve the production build locally
```

The build is configured for the `/KomaYomi-online/` sub-path in `vite.config.ts`, which is what GitHub Pages uses for a project site. Change `base` there if you deploy under a different path or domain.

### Project structure

```text
src/                 React UI (copied from KomaYomi, trimmed for the static edition)
  api.ts             API-shaped facade implemented entirely in the browser
  static/db.ts       IndexedDB stores: workspace metadata, page documents, images
  static/projectStore.ts  .mnproj import/export, library building, object URLs
  static/exportHtml.ts    self-contained HTML export
  components/        Sidebar, CompareTab, PanelsTab, NotesPanel, dialogs…
shared/              Types, schema migrations, Markdown and panel-ordering helpers
scripts/make-sample.mjs  Regenerates public/samples/demo.mnproj from the CC0 demo artwork
```

The UI is the same as the local app; only `src/api.ts` is replaced with a static implementation. Unsupported endpoints raise `OnlineUnsupportedError`, and the corresponding menu items are removed rather than failing at click time.

### Sample project

`public/samples/demo.mnproj` is generated from the CC0 "Star Cafe" demo artwork that ships with KomaYomi. Regenerate it with:

```bash
node scripts/make-sample.mjs
```

No third-party manga, scans or copyrighted material is included in this repository.

## Deployment

`.github/workflows/deploy.yml` builds on every push to `main` and publishes `dist` with the official GitHub Pages actions. One-time setup in the repository: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

## License

Released under the [MIT License](LICENSE), same as [KomaYomi](https://github.com/PayayaKamo/KomaYomi).
