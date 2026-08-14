# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

How we cut releases: [docs/RELEASE.md](docs/RELEASE.md).

## [Unreleased]

### Added
- Standalone My Icons can open a trusted personal icon in Icon Studio as an in-memory copy and upload the result without changing or assigning the source icon.
- Per-track icon assignment, clearing, Reset, and rapid navigation for standalone and Save As drafts before Create.
- Fast multi-track icon assignment from the playlist editor, with previous and next navigation.
- Experimental paginated Yotoicons community search and import into the personal icon library.
- Safe, exact-title-confirmed deletion of owned Yoto playlists.
- Lossless Save As for existing Yoto playlists and MYO cards, creating detached duplicates that reuse source media.
- Lossless track rename and removal for existing MYO cards, with one-step Undo for removals.
- Lossless per-track icon assignment for existing MYO cards, including personal-library selection, chapter inheritance, batching, and Reset support.
- Personal Yoto icon browsing and a local 16×16 crop/preview editor with reusable icon uploads.
- Existing Yoto playlists and MYO cards can now be renamed directly in the editor.
- Standalone Yoto playlist creation from local drafts with reviewed YouTube tracks and explicit Create confirmation.
- Review-and-append import for public YouTube playlists, including pagination, duplicate detection, availability checks, and MYO capacity filtering.
- yt-dlp download outcome logs (`ok` / `fail` / `escalate` / `coalesce`) so Railway logs show whether cookies recovered after bot checks.
- In-process singleflight for concurrent downloads of the same YouTube id (preview stampede protection).

### Changed
- "Check My Cards" after an uncertain playlist create is now a live button: it refreshes the card list and pulses the My Cards bay instead of doing nothing.
- YouTube search failures now show a proper error state with the reason and a Try again button instead of a bare red line.
- Search result thumbnail and title are one labeled select control, and preview play/seek controls announce which track they belong to.
- Search results use conforming list semantics for assistive tech (previously a listbox with interactive controls nested in options).
- The disabled Import playlist button now explains why it is disabled on keyboard focus, not only on mouse hover.
- Save and operation progress bars animate with transforms instead of layout for smoother progress rendering.
- The typewriter search placeholder pauses while a full-screen overlay (splash, auth TV, welcome) covers the app.
- Search suggestion chips start their color cycle at a varied point per placeholder set; adjacent chips never share a hue.
- Personal icon uploads now block blind retry after uncertain or accepted-but-unrefreshed outcomes until My Icons is explicitly refreshed.
- Expected anon→cookies escalate and retries log at info level (not warn/error).
- Long API errors use h3 `message` instead of `statusMessage` (avoids future sanitization warnings).
- Demo runbook: cookies required on cloud IPs, `YTDLP_CACHE_BUST`, restart/job-loss notes, how to read yt-dlp logs.

## [1.0.0] - 2026-07-22

### Added
- Intro splash sequence (Lottie) on first visit per tab session, with a short delay before playback and a frame-synced Louis sound cue (`splashCue` / `louis.wav`).
- Splash debug mode via `?splash=debug` (loop, pause, frame HUD).
- Early splash cover so the main app does not flash before the intro.
- Post-auth welcome modal (`YotoConnectedModal`) after successful Yoto OAuth (`/?yoto=connected`), with feature list, TV frame UI, and celebration sound.
- Auth gate uses the Yoto-on SVG as a TV frame with Louis artwork; connect CTA plays `toggle_on`, gate open plays ringtone.
- `lottie-web` dependency for splash playback.

### Changed
- Successful OAuth callback redirects to `/?yoto=connected` instead of bare `/`.
- Auth gate copy updated to “Connect Louis to Yoto”; connect-gate and welcome typography/spacing tightened.
- YouTube result card channel meta uses tighter line-height.
- Docs and browser title brand the app as **Louis** (README banner, CONTRIBUTING, ROADMAP, DEMO, LICENSE).

### Removed
- Marketing page (`/marketing`) and `public/marketing/` assets (Louis/Yoto art lives under `public/images/`).
- Experimental muted `<video>` splash cue path (`louis.mp4`); splash audio uses the shared UI sound player only.

[Unreleased]: https://github.com/stuartromanek/louis-/compare/v1.0.0...main
[1.0.0]: https://github.com/stuartromanek/louis-/releases/tag/v1.0.0
