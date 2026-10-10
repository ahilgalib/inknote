# Inkwell Notes

**Free, open-source handwritten notes for iPad + Apple Pencil, phones and desktop.**
A Notability-style note app that runs in the browser, installs to your home screen, and works fully offline. No account, no server: your notes stay on your device.

**Live app:** https://inkwell-notes.mahilgalib.workers.dev

![Inkwell icon](icons/icon-192.png)

## Features

**Writing**
- Smooth, pressure-sensitive ink tuned for Apple Pencil (uses coalesced and predicted pointer events for low latency)
- Palm rejection: once a Pencil is detected, fingers only scroll and zoom (configurable: Auto / On / Off)
- Pen, highlighter (drawn under the ink), and eraser (whole stroke or precise/partial)
- **Draw & hold** to turn a rough stroke into a clean line, circle, ellipse, rectangle, triangle or polygon
- 5 favourite colours and 3 sizes per tool; tap a selected colour to pick any colour
- Lasso: select ink, text and images, then move, resize, recolour, duplicate, copy/cut/paste or delete
- Text boxes (sans, serif, mono, handwriting fonts)
- Insert images and photos (camera on iPad/iPhone)
- Unlimited undo / redo; two-finger tap = undo, three-finger tap = redo

**Pages & paper**
- Continuous vertical scrolling pages with pinch zoom
- Templates: blank, lined, narrow, grid, fine grid, dots, Cornell, music
- Paper colours (white, cream, blue, green, dark) and sizes (Letter, A4, A5, 16:9, square)
- Page panel: jump, reorder, duplicate, delete; new pages are added automatically as you write
- **Import a PDF** to annotate (lecture slides, worksheets, forms)

**Audio**
- Record audio while you write; every stroke is time-stamped
- Replay mode shows your notes appearing in sync with the recording; tap any handwriting to jump to that moment
- Playback speed 0.75×–2×, ±10 s skip, multiple recordings per note

**Organise & share**
- Subjects (colour-coded folders), search (titles and typed text), sort
- Export as PDF, page as PNG, or a note file; native share sheet on iPad/iPhone
- Full backup export / import to move notes between devices
- Light and dark themes; installable PWA that works offline

## Install on iPad / iPhone

1. Open the app in **Safari**.
2. Tap **Share → Add to Home Screen**.
3. Launch it from the home screen for a full-screen, offline app.

On Android / Windows / Mac use Chrome or Edge's **Install** button.

> Notes are stored in your browser (IndexedDB) on that device. Use **Settings → Export backup** regularly, and **Import backup** to move notes to another device.

## Run locally

No build step and no dependencies — it's plain HTML, CSS and JavaScript modules.

```bash
node dev-server.mjs
```

Then open http://localhost:8801. To try it on your iPad, open `http://<your-computer-ip>:8801` (note: the service worker and some APIs need HTTPS or localhost).

## Deploy your own

Any static host works. The repo root is the site.

- **Cloudflare:** `npx wrangler pages deploy . --project-name your-name` (or Workers static assets)
- **GitHub Pages:** Settings → Pages → deploy from branch `main`, folder `/`
- **Netlify / Vercel:** import the repo, no build command, output directory `.`

## Project layout

```
index.html            app shell
styles.css            all styling (light/dark)
sw.js                 offline cache (service worker)
js/app.js             routing between library and editor
js/library.js         subjects, note grid, search, settings, backup
js/editor.js          canvas, Pencil/touch/mouse input, tools, undo, pages, audio
js/ink.js             pressure-sensitive stroke geometry and hit-testing
js/shapes.js          draw-and-hold shape recognition
js/render.js          page rendering (shared by editor, thumbnails, export)
js/templates.js       paper templates, colours and sizes
js/notes.js           note model, PDF export/import, backup files
js/pdf.js             PDF reader loader + tiny PDF writer
js/db.js              IndexedDB storage
vendor/pdfjs/         Mozilla pdf.js 3.11.174 (Apache-2.0)
```

## Keyboard shortcuts (desktop / iPad keyboard)

| Key | Action |
| --- | --- |
| P / H / E / L / T | Pen / Highlighter / Eraser / Lasso / Text |
| Space + drag | Scroll |
| Ctrl/⌘ + Z, Ctrl/⌘ + Shift + Z | Undo, redo |
| Ctrl/⌘ + C / X / V / D | Copy, cut, paste, duplicate selection |
| Delete | Delete selection |
| Ctrl/⌘ + = / − / 0 | Zoom in, out, fit width |
| Page Up / Page Down | Previous / next page |

## Contributing

Issues and pull requests are welcome. Please keep the app dependency-free and test on iPad Safari with an Apple Pencil when touching input code.

## License

[MIT](LICENSE). Bundled pdf.js is © Mozilla Foundation, Apache License 2.0 (`vendor/pdfjs/LICENSE`).
