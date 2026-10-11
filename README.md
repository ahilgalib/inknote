# Inknote

**Free, open-source handwritten notes for iPad + Apple Pencil, phones and desktop — like Notability.**
Works offline, installs to your home screen, and syncs automatically across all your devices.

**Live app:** https://inknote.pages.dev

![Inknote icon](public/icons/icon-192.png)

## Features

**Writing (tuned for Apple Pencil)**
- Smooth, pressure-sensitive ink: curve-fitted strokes, smoothed pressure, no redraw lag, saving never runs while the pen is down
- Pen styles: fountain, ballpoint, **calligraphy**, **pencil**, dashed, dotted · highlighter (under the ink, optional straight lines) · laser pointer
- **Favourite pens**: save any pen / highlighter / tape with ★ and switch in one tap
- **Toolbox** (like Notability): **Zoom window** (write big in a magnified panel, it lands small on the page, auto-advances), **Tape** (cover answers and tap to peek — quiz yourself), **Ruler** (draw along its edge at any angle, snaps to 15°), Laser, emoji **Stickers**, **Sticky notes**, **Find in note**, **Eyedropper**
- Shapes can be filled; page bookmarks; go to page; lock a note (read only)
- Palm rejection: once a Pencil is used, fingers only scroll and zoom (Auto / On / Off)
- Notability-style eraser: **precise**, **whole stroke**, or **highlighter only** — and it jumps back to your pen after erasing
- Stylus eraser end / eraser button supported
- Draw & hold → perfect line, circle, ellipse, rectangle, triangle, polygon
- Lasso: move, resize from any corner, **rotate**, recolour, bring to front/back, duplicate, copy/cut/paste, delete — the selection lifts off the page and follows your finger smoothly, and can be dropped onto another page
- **Dark / light pages** in one tap: black ink shows white on dark paper and white ink shows black on light paper; other colours never change
- Text boxes with **any Google Font** (1,700+ incl. Bangla), bold/italic/underline, alignment, your own .ttf/.otf — drag a text box (text tool or the grip while typing) to move it, drag its edge to change the width
- Pictures: tap one to get its options — **sticker** (die-cut white border + shadow), crop, rotate, flip, copy, duplicate, front/back, delete; drag to move, corners to resize
- Insert menu: photo, camera, audio file, recording, text, paste, PDF; drag & drop works too
- Paste from other apps (Notability, Photos, browsers): pictures, PDF selections, audio files, rich text with images, plain text; copy puts a PNG on the system clipboard

**Procreate-style gestures**
| Gesture | Action |
| --- | --- |
| Two-finger tap / hold | Undo / rapid undo |
| Three-finger tap | Redo |
| Three-finger swipe down | Copy & paste menu |
| Four-finger tap | Full screen |
| Pinch / quick pinch in | Zoom / fit width |

**Pages & templates**
- Continuous pages, page thumbnails, add / reorder / duplicate / delete, auto-add page
- 12 papers (lined, grid, dots, Cornell, music, isometric, storyboard, to-do…)
- 24 detailed planner templates (Assignment Planner, Daily Goals, Daily Planner light/dark, Habit Tracker, Mind Map, Monthly/Weekly Planner, Finance, Travel, Flashcards, Lecture & Meeting notes…)
- Customise accent colour, paper colour, heading, size & orientation
- Import PDFs (annotate) and images as pages; export PDF, PNG, note file; print

**Audio**
- Record while writing; replay shows ink appearing in sync; tap handwriting to jump there
- Live transcript where the browser supports speech recognition; insert transcript as text
- Audio clips on the page: add audio files (or place a recording) as a clip you tap to play; move and copy them like anything else

**Library & sync**
- Notability-style home: quick actions, templates, recent notes; folders; **Favorites**; grid or list view; search; Recently Deleted (30 days)
- **Scan documents** with the camera (paper turns white, ink dark)
- Free account (**Continue with Google** or email) → automatic background sync of notes, folders, images, PDFs and audio
- Fully offline: everything saves on the device first and syncs when you're back online; if the same note was edited on two devices, both sets of changes are merged (nothing written offline is lost)
- Sync status in the editor: Offline · Syncing · Synced
- Backup export / import

## Install on iPad / iPhone
Open https://inknote.pages.dev in Safari → **Share → Add to Home Screen**. Rotation, split view and Stage Manager resize automatically.

## Run locally
```bash
npm install
npm run db:local
npm run dev
```
Open http://localhost:8801.

## Deploy your own (Cloudflare Pages + D1)
1. `npx wrangler d1 create inknote` and put the id in `wrangler.toml`
2. `npm run db:remote`
3. `npm run deploy`

Or let GitHub deploy for you: add the repository secrets `CLOUDFLARE_API_TOKEN` (a token with *Account → Cloudflare Pages → Edit*) and `CLOUDFLARE_ACCOUNT_ID`; every push to `main` then deploys automatically (`.github/workflows/deploy.yml`).

Without the `functions/` API the app still works fully offline (no sync).

### Sign in with Google (optional)
1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials) create an **OAuth client ID** of type *Web application* and add your site (e.g. `https://inknote.pages.dev`) to **Authorized JavaScript origins**.
2. In Cloudflare → Workers & Pages → *inknote* → Settings → **Variables and Secrets**, add `GOOGLE_CLIENT_ID` = that client id (Production), then redeploy.
The “Continue with Google” button appears automatically once the variable is set.

## Layout
```
public/            the app (plain HTML/CSS/JS modules, no build step)
  js/editor.js     canvas, input, tools, gestures, clipboard, audio
  js/ink.js        stroke geometry & hit testing
  js/templates.js  papers and planner templates
  js/sync.js       offline-first sync engine
  js/fonts.js      Google Fonts / custom fonts
functions/api/     sync & account API (Pages Functions)
schema.sql         D1 schema
```

## License
[MIT](LICENSE). Bundled pdf.js © Mozilla Foundation (Apache-2.0).
