/** Tokens copied from @memnox/ui's globals.css — this repo cannot import them. */
export const DASHBOARD_CSS = `
:root {
  color-scheme: light;
  --background: #f1f5f9;
  --foreground: #0f172a;
  --surface: #f8fafc;
  --card: #ffffff;
  --primary: #1e86ee;
  --primary-foreground: #ffffff;
  --secondary: #eef2ff;
  --muted: #f1f5f9;
  --muted-foreground: #475569;
  --accent: #1e86ee;
  --destructive: #e31957;
  --destructive-foreground: #ffffff;
  --border: #dfe7f1;
  --input: #f8fafc;
  --ring: rgba(30, 134, 238, 0.35);
  /* chart-4 and chart-5 are the palette's allow and warn hues. */
  --chart-4: #37cd8f;
  --chart-5: #dd815d;
  --radius: 0.375rem;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --background: #0c0c0c;
    --foreground: #f5f5f5;
    --surface: #141414;
    --card: #1c1c1c;
    --secondary: #232323;
    --muted: #1f1f1f;
    --muted-foreground: #a3a3a3;
    --border: #2e2e2e;
    --input: #171717;
    --ring: rgba(30, 134, 238, 0.45);
  }
}

:root[data-theme="dark"] {
  color-scheme: dark;
  --background: #0c0c0c;
  --foreground: #f5f5f5;
  --surface: #141414;
  --card: #1c1c1c;
  --secondary: #232323;
  --muted: #1f1f1f;
  --muted-foreground: #a3a3a3;
  --border: #2e2e2e;
  --input: #171717;
  --ring: rgba(30, 134, 238, 0.45);
}

/*
 * Two shapes carry every surface, as in the client: --radius for controls and
 * small tiles, --radius-xl for cards and panels. Two elevations, no third.
 */
:root {
  --radius-xl: calc(var(--radius) + 6px);
  --shadow-soft: 0 8px 24px rgb(0 0 0 / 0.1);
  --shadow-lifted: 0 24px 60px rgb(0 0 0 / 0.18);
  --font-sans: "Instrument Sans", ui-sans-serif, system-ui, -apple-system, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  /* The four steps below Tailwind's sm, named for the job they do. */
  --text-caption: 0.625rem;
  --text-label: 0.6875rem;
  --text-meta: 0.75rem;
  --text-body-sm: 0.8125rem;
  --text-body: 0.875rem;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--background);
  color: var(--foreground);
  font: var(--text-body)/1.5 var(--font-sans);
  -webkit-font-smoothing: antialiased;
}

/* The dotted ground the client draws its own surfaces on. */
body::before {
  content: "";
  position: fixed;
  inset: 0;
  pointer-events: none;
  background-image: radial-gradient(
    circle,
    color-mix(in srgb, var(--foreground) 12%, transparent) 1px,
    transparent 1px
  );
  background-size: 22px 22px;
  opacity: .5;
}

main { position: relative; max-width: 72rem; margin: 0 auto; padding: 1.75rem 1.5rem 4rem; }

a, button {
  cursor: pointer;
  transition: color .2s ease, background-color .2s ease, border-color .2s ease,
    box-shadow .2s ease;
}

/* WCAG 2.4.7, matching the client: one ring, on --primary, clearing both themes. */
a:focus-visible, button:focus-visible, input:focus-visible,
select:focus-visible, textarea:focus-visible, [role="tab"]:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 3px;
  border-radius: var(--radius);
}
a:focus:not(:focus-visible), button:focus:not(:focus-visible),
input:focus:not(:focus-visible), select:focus:not(:focus-visible) { outline: none; }

/* ── the lockup ───────────────────────────────────────────── */
.topbar { display: flex; align-items: center; gap: .75rem; padding-bottom: 1.25rem; }
.lockup { display: flex; flex-shrink: 0; align-items: center; }
.lockup img { width: 1.75rem; height: 1.75rem; object-fit: contain; margin-right: -0.25rem; }
.lockup .word {
  font-size: 1.125rem; font-weight: 600; line-height: .95;
  letter-spacing: -.02em; color: var(--foreground);
}
.lockup .suffix {
  margin-left: .625rem; font-family: var(--font-mono); font-size: var(--text-meta);
  text-transform: uppercase; letter-spacing: .18em; color: var(--muted-foreground);
}
.spacer { flex: 1; }

.mode {
  font-family: var(--font-mono); font-size: var(--text-label); font-weight: 600;
  letter-spacing: .18em; text-transform: uppercase; line-height: 1;
  padding: .4rem .6rem; border-radius: 999px; border: 1px solid var(--border);
}
.mode-observing { color: var(--chart-5); border-color: var(--chart-5); }
.mode-enforcing { color: var(--chart-4); border-color: var(--chart-4); }

.live {
  display: inline-flex; align-items: center; gap: .4rem;
  font-family: var(--font-mono); font-size: var(--text-meta); line-height: 1;
  color: var(--muted-foreground); background: none;
  border: 1px solid var(--border); border-radius: 999px; padding: .45rem .7rem;
  height: auto;
}
.live:hover { color: var(--foreground); border-color: color-mix(in srgb, var(--foreground) 30%, transparent); background: none; }
.live::before { content: ""; width: .45rem; height: .45rem; border-radius: 999px; background: var(--chart-4); }
.live[data-paused="true"]::before { background: var(--muted-foreground); }

/* ── banner ──────────────────────────────────────────────── */
.banner {
  background: var(--card); border: 1px solid var(--border);
  border-left: 3px solid var(--chart-5); border-radius: var(--radius-xl);
  padding: .8rem 1rem; margin: 0 0 1.25rem; color: var(--muted-foreground);
  font-size: var(--text-body-sm);
}
.banner.hidden, .hidden { display: none !important; }

/* ── tiles ───────────────────────────────────────────────── */
.tiles { display: grid; gap: .75rem; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); }
.tile {
  background: var(--card); border: 1px solid var(--border);
  border-radius: var(--radius-xl); padding: 1rem 1.1rem; box-shadow: var(--shadow-soft);
}
.tile-attention { border-color: var(--chart-5); }
.tile-value {
  font-size: 1.75rem; font-weight: 600; line-height: 1.25;
  letter-spacing: -.02em; font-variant-numeric: tabular-nums;
}
.tile-label { font-size: var(--text-body-sm); margin-top: .2rem; }
.tile-hint { font-size: var(--text-meta); color: var(--muted-foreground); }

/* ── tabs ────────────────────────────────────────────────── */
.tabs {
  display: flex; gap: .25rem; margin: 1.75rem 0 1.15rem;
  border-bottom: 1px solid var(--border); overflow-x: auto;
}
.tab {
  appearance: none; background: none; border: 0; height: auto;
  color: var(--muted-foreground); font-family: var(--font-sans);
  font-size: var(--text-body-sm); font-weight: 500; line-height: 1;
  padding: .65rem .8rem; border-bottom: 2px solid transparent; white-space: nowrap;
  border-radius: 0;
}
.tab:hover { color: var(--foreground); background: none; border-color: transparent; }
.tab[aria-selected="true"] { color: var(--foreground); border-bottom-color: var(--primary); }
.tab .count {
  font-family: var(--font-mono); font-size: var(--text-caption); font-weight: 600;
  line-height: 1; margin-left: .4rem; padding: .2rem .4rem; border-radius: 999px;
  background: var(--secondary); color: var(--muted-foreground);
}
.tab .count.attention { background: var(--chart-5); color: #fff; }

/* ── panes, headings, cards ──────────────────────────────── */
.stack { display: flex; flex-direction: column; gap: 1rem; }
/* Only a top-level pane answers to the tab strip; .stack stays pure layout, so
   a form or a list inside a pane can use it without being hidden by a tab. */
.pane[hidden] { display: none; }
h2 {
  font-family: var(--font-mono); font-size: var(--text-label); font-weight: 600;
  line-height: 1.5; letter-spacing: .18em; text-transform: uppercase;
  color: var(--muted-foreground); margin: 0;
}
.card {
  background: var(--card); border: 1px solid var(--border);
  border-radius: var(--radius-xl); box-shadow: var(--shadow-soft); overflow: hidden;
}
.card-head {
  display: flex; align-items: center; gap: .6rem;
  padding: .8rem 1rem; border-bottom: 1px solid var(--border);
}
.card-head h3 { margin: 0; font-size: var(--text-body); font-weight: 600; }
.card-body { padding: 1rem; display: flex; flex-direction: column; gap: .8rem; }
.dim { color: var(--muted-foreground); }
.empty { color: var(--muted-foreground); padding: 1.25rem 1rem; font-size: var(--text-body-sm); }

/* ── forms ───────────────────────────────────────────────── */
.grid { display: grid; gap: .7rem; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); }
label { display: flex; flex-direction: column; gap: .3rem; font-size: var(--text-meta); }
label > span:first-child { font-weight: 600; }
label .hint { color: var(--muted-foreground); font-weight: 400; font-size: var(--text-meta); }
input, select, textarea {
  font-family: var(--font-sans); font-size: var(--text-body-sm); line-height: 1.5;
  color: var(--foreground); background: var(--input);
  border: 1px solid var(--border); border-radius: var(--radius);
  padding: .45rem .6rem; width: 100%; min-height: 2.25rem;
}
textarea { min-height: 4.5rem; resize: vertical; }
input.mono, textarea.mono { font-family: var(--font-mono); font-size: var(--text-meta); }
.auto-width { width: auto; }
.narrow { max-width: 20rem; }
.row { display: flex; gap: .4rem; align-items: stretch; }
.row button { white-space: nowrap; }
.actions { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; }

/*
 * The button variants from @memnox/ui: one shape, one transition, and the
 * default carrying the ring as a hairline the way the client's does.
 */
button {
  appearance: none; display: inline-flex; align-items: center; justify-content: center;
  gap: .5rem; white-space: nowrap; height: 2.25rem; padding: 0 1rem;
  font-family: var(--font-sans); font-size: var(--text-body-sm); font-weight: 500;
  border-radius: var(--radius); border: 1px solid var(--border);
  background: transparent; color: var(--foreground);
  transition: all .2s ease-out;
}
button:hover {
  border-color: color-mix(in srgb, var(--foreground) 30%, transparent);
  background: color-mix(in srgb, var(--muted) 60%, transparent);
}
button.primary {
  background: var(--primary); border-color: var(--primary);
  color: var(--primary-foreground); box-shadow: 0 0 0 1px var(--ring);
}
button.primary:hover { background: color-mix(in srgb, var(--primary) 90%, transparent); }
button.danger {
  background: var(--destructive); border-color: var(--destructive);
  color: var(--destructive-foreground);
}
button.danger:hover { background: color-mix(in srgb, var(--destructive) 90%, transparent); }
button.ghost { height: 2rem; padding: 0 .75rem; border-color: transparent; color: var(--muted-foreground); }
button.ghost:hover {
  color: var(--foreground); border-color: transparent;
  background: color-mix(in srgb, var(--accent) 10%, transparent);
}
button[disabled] { pointer-events: none; opacity: .5; }

/* ── tables ──────────────────────────────────────────────── */
.scroller { overflow-x: auto; scrollbar-gutter: stable; }
table { width: 100%; border-collapse: collapse; font-size: var(--text-body-sm); }
th {
  text-align: left; font-family: var(--font-mono); font-size: var(--text-label);
  font-weight: 600; line-height: 1.5; letter-spacing: .18em; text-transform: uppercase;
  color: var(--muted-foreground);
}
th, td { padding: .6rem .8rem; border-bottom: 1px solid var(--border); vertical-align: top; }
tbody tr:last-child td { border-bottom: 0; }
td.n { font-family: var(--font-mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
/* Label/value pairs inside a card are not data — keep the label column narrow. */
.card-body th { width: 9rem; }
code { font-family: var(--font-mono); font-size: .95em; }

.verdict { font-family: var(--font-mono); font-size: var(--text-label); font-weight: 700; letter-spacing: .06em; }
.verdict-allow { color: var(--chart-4); }
.verdict-block { color: var(--destructive); }
.verdict-require_approval { color: var(--chart-5); }
.verdict-redact { color: var(--primary); }
.tag {
  font-family: var(--font-mono); font-size: var(--text-caption); font-weight: 600;
  line-height: 1; padding: .25rem .45rem; border-radius: 999px;
  border: 1px solid var(--border); color: var(--muted-foreground);
  margin-left: .4rem; white-space: nowrap;
}
.tag.alarm { color: var(--destructive); border-color: var(--destructive); }
.chips { display: flex; flex-wrap: wrap; gap: .35rem; padding: 0; margin: 0; list-style: none; }
.chips li {
  font-family: var(--font-mono); font-size: var(--text-meta); line-height: 1;
  padding: .35rem .6rem; border-radius: 999px;
  background: var(--secondary); border: 1px solid var(--border);
}

.readout {
  font-family: var(--font-mono); font-size: var(--text-meta); line-height: 1.65;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: .9rem 1rem;
  white-space: pre-wrap; word-break: break-word; margin: 0;
}

/* ── the token gate ──────────────────────────────────────── */
.gate {
  position: relative; max-width: 26rem; margin: 5rem auto; background: var(--card);
  border: 1px solid var(--border); border-radius: var(--radius-xl);
  box-shadow: var(--shadow-lifted); padding: 1.75rem;
  display: flex; flex-direction: column; gap: 1rem;
}
.gate .eyebrow {
  font-family: var(--font-mono); font-size: var(--text-label); font-weight: 600;
  letter-spacing: .18em; text-transform: uppercase; color: var(--muted-foreground);
}
.gate h1 { font-size: 1.5rem; font-weight: 600; letter-spacing: -.02em; line-height: 1.25; margin: 0; }
.gate p { margin: 0; color: var(--muted-foreground); font-size: var(--text-body-sm); }

/* ── toast ───────────────────────────────────────────────── */
.toast {
  position: fixed; right: 1.25rem; bottom: 1.25rem; max-width: 26rem;
  background: var(--card); color: var(--foreground);
  border: 1px solid var(--border); border-left: 3px solid var(--primary);
  border-radius: var(--radius-xl); box-shadow: var(--shadow-lifted);
  padding: .75rem 1rem; font-size: var(--text-body-sm);
  opacity: 0; transform: translateY(.4rem); pointer-events: none;
  transition: opacity .2s ease, transform .2s ease;
}
.toast[data-open="true"] { opacity: 1; transform: none; }
.toast[data-tone="bad"] { border-left-color: var(--destructive); }
.toast[data-tone="good"] { border-left-color: var(--chart-4); }
@media (prefers-reduced-motion: reduce) {
  .toast, a, button { transition: none; }
}

footer { margin-top: 2.75rem; font-size: var(--text-meta); color: var(--muted-foreground); }
`;
