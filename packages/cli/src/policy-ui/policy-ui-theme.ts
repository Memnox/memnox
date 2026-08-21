/** Tokens copied verbatim from @memnox/ui's globals.css — this repo cannot import them. */
export const POLICY_UI_CSS = String.raw`
:root {
  color-scheme: light;
  --background: #f8fafc;
  --foreground: #0f172a;
  --card: #ffffff;
  --card-foreground: #0f172a;
  --popover: #ffffff;
  --popover-foreground: #0f172a;
  --primary: #1e86ee;
  --primary-foreground: #ffffff;
  --secondary: #eef2ff;
  --secondary-foreground: #111827;
  --muted: #f1f5f9;
  --muted-foreground: #475569;
  --accent: #1e86ee;
  --accent-foreground: #ffffff;
  --destructive: #e31957;
  --destructive-foreground: #ffffff;
  --border: #dfe7f1;
  --input: #f8fafc;
  --ring: rgba(30, 134, 238, 0.35);
  --chart-4: #37cd8f;
  --chart-5: #dd815d;
  --radius: 0.375rem;
  --radius-xl: calc(var(--radius) + 6px);
  --shadow-soft: 0 8px 24px rgb(0 0 0 / 0.1);
  --font-sans: "Instrument Sans", system-ui, -apple-system, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  --font-display: "Instrument Serif", Georgia, serif;
}

:root[data-theme="dark"] {
  color-scheme: dark;
  --background: #171717;
  --foreground: #f5f5f5;
  --card: #1c1c1c;
  --card-foreground: #f5f5f5;
  --popover: #1c1c1c;
  --popover-foreground: #f5f5f5;
  --secondary: #1c1c1c;
  --secondary-foreground: #f5f5f5;
  --muted: #1f1f1f;
  --muted-foreground: #a3a3a3;
  --border: #2e2e2e;
  --input: #1e1e1e;
  --ring: rgba(30, 134, 238, 0.45);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --background: #171717;
    --foreground: #f5f5f5;
    --card: #1c1c1c;
    --card-foreground: #f5f5f5;
    --popover: #1c1c1c;
    --popover-foreground: #f5f5f5;
    --secondary: #1c1c1c;
    --secondary-foreground: #f5f5f5;
    --muted: #1f1f1f;
    --muted-foreground: #a3a3a3;
    --border: #2e2e2e;
    --input: #1e1e1e;
    --ring: rgba(30, 134, 238, 0.45);
  }
}

* { box-sizing: border-box; border-color: var(--border); }

html { color-scheme: light dark; }

body {
  margin: 0;
  background: var(--background);
  color: var(--foreground);
  font-family: var(--font-sans);
  font-size: 0.875rem;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}

a, button, summary { cursor: pointer; transition: color .2s ease, background-color .2s ease, border-color .2s ease, box-shadow .2s ease; }

a:focus-visible, button:focus-visible, input:focus-visible,
select:focus-visible, textarea:focus-visible, summary:focus-visible,
[tabindex]:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 3px;
  border-radius: var(--radius);
}
a:focus:not(:focus-visible), button:focus:not(:focus-visible) { outline: none; }

/* ── button ──────────────────────────────────────────────────────────────── */
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: .5rem;
  white-space: nowrap; border-radius: var(--radius); border: 1px solid transparent;
  font: inherit; font-size: .875rem; font-weight: 500;
  height: 2.25rem; padding: 0 1rem; flex-shrink: 0;
  background: var(--primary); color: var(--primary-foreground);
  box-shadow: 0 0 0 1px var(--ring);
}
.btn:hover:not(:disabled) { background: color-mix(in srgb, var(--primary) 90%, black); color: var(--primary-foreground); }
.btn:disabled { pointer-events: none; opacity: .5; }
.btn-sm { height: 2rem; padding: 0 .75rem; font-size: .8125rem; gap: .375rem; }
.btn-outline {
  background: transparent; color: var(--foreground);
  border-color: var(--border); box-shadow: none;
}
.btn-outline:hover:not(:disabled) { background: color-mix(in srgb, var(--muted) 60%, transparent); border-color: color-mix(in srgb, var(--foreground) 30%, transparent); color: var(--foreground); }
.btn-ghost { background: transparent; color: var(--foreground); box-shadow: none; }
.btn-ghost:hover:not(:disabled) { background: color-mix(in srgb, var(--accent) 10%, transparent); color: var(--foreground); }
.btn-destructive { background: var(--destructive); color: var(--destructive-foreground); box-shadow: none; }
.btn-destructive:hover:not(:disabled) { background: color-mix(in srgb, var(--destructive) 90%, black); color: var(--destructive-foreground); }
.btn-icon { width: 2rem; height: 2rem; padding: 0; }

/* ── card ────────────────────────────────────────────────────────────────── */
.card {
  background: var(--card); color: var(--card-foreground);
  border: 1px solid var(--border); border-radius: var(--radius-xl);
  box-shadow: var(--shadow-soft);
}
.card-header { padding: 1.25rem 1.25rem 0; }
.card-title { font-weight: 600; line-height: 1; }
.card-description { color: var(--muted-foreground); font-size: .8125rem; margin-top: .375rem; }
.card-content { padding: 1.25rem; }

/* ── badge ───────────────────────────────────────────────────────────────── */
.badge {
  display: inline-flex; align-items: center; justify-content: center; gap: .25rem;
  border-radius: var(--radius); border: 1px solid transparent;
  padding: .0625rem .5rem; font-size: .75rem; font-weight: 500; width: fit-content;
  white-space: nowrap;
}
.badge-outline { color: var(--foreground); border-color: var(--border); }
.badge-muted { background: var(--muted); color: var(--muted-foreground); }

/* Effect colours: the four decisions, each one hue, everywhere they appear. */
.effect-allow { background: color-mix(in srgb, var(--chart-4) 18%, transparent); color: color-mix(in srgb, var(--chart-4) 75%, var(--foreground)); }
.effect-redact { background: color-mix(in srgb, var(--chart-5) 18%, transparent); color: color-mix(in srgb, var(--chart-5) 75%, var(--foreground)); }
.effect-require_approval { background: color-mix(in srgb, var(--primary) 16%, transparent); color: color-mix(in srgb, var(--primary) 80%, var(--foreground)); }
.effect-block { background: color-mix(in srgb, var(--destructive) 16%, transparent); color: color-mix(in srgb, var(--destructive) 80%, var(--foreground)); }

.dot { width: .5rem; height: .5rem; border-radius: 9999px; flex-shrink: 0; }
.dot.effect-allow { background: var(--chart-4); }
.dot.effect-redact { background: var(--chart-5); }
.dot.effect-require_approval { background: var(--primary); }
.dot.effect-block { background: var(--destructive); }

/* ── input / label ───────────────────────────────────────────────────────── */
.label {
  display: flex; align-items: center; gap: .5rem;
  font-size: .8125rem; font-weight: 500; line-height: 1;
  user-select: none; margin-bottom: .4375rem;
}
.label .hint { color: var(--muted-foreground); font-weight: 400; font-size: .75rem; }

.input, .select, .textarea {
  width: 100%; min-width: 0; height: 2.25rem;
  border: 1px solid var(--border); border-radius: var(--radius);
  background: transparent; color: inherit;
  padding: 0 .75rem; font: inherit; font-size: .875rem;
  transition: color .2s ease, box-shadow .2s ease, border-color .2s ease;
}
.textarea { height: auto; min-height: 4.5rem; padding: .5rem .75rem; resize: vertical; font-family: var(--font-mono); font-size: .8125rem; }
.input::placeholder, .textarea::placeholder { color: var(--muted-foreground); }
.input:focus-visible, .select:focus-visible, .textarea:focus-visible {
  outline: none; border-color: var(--primary);
  box-shadow: 0 0 0 3px var(--ring);
}
.select { appearance: none; padding-right: 2rem; background-image: linear-gradient(45deg, transparent 50%, currentColor 50%), linear-gradient(135deg, currentColor 50%, transparent 50%); background-position: right 1rem center, right .75rem center; background-size: .3rem .3rem; background-repeat: no-repeat; }
.field { margin-bottom: 1rem; }
.field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }

/* ── chip input ──────────────────────────────────────────────────────────── */
.chips {
  display: flex; flex-wrap: wrap; align-items: center; gap: .375rem;
  min-height: 2.25rem; padding: .3125rem .5rem;
  border: 1px solid var(--border); border-radius: var(--radius);
}
.chips:focus-within { border-color: var(--primary); box-shadow: 0 0 0 3px var(--ring); }
.chip {
  display: inline-flex; align-items: center; gap: .25rem;
  background: var(--muted); color: var(--foreground);
  border-radius: var(--radius); padding: .125rem .25rem .125rem .5rem;
  font-family: var(--font-mono); font-size: .75rem;
}
.chip button {
  border: 0; background: transparent; color: var(--muted-foreground);
  font-size: .875rem; line-height: 1; padding: 0 .1875rem; border-radius: var(--radius);
}
.chip button:hover { color: var(--destructive); }
.chips input {
  flex: 1 1 6rem; min-width: 4rem; border: 0; background: transparent;
  color: inherit; font: inherit; font-size: .8125rem; padding: .125rem;
}
.chips input:focus { outline: none; }

/* ── layout ──────────────────────────────────────────────────────────────── */
.topbar {
  position: sticky; top: 0; z-index: 10;
  display: flex; align-items: center; gap: 1rem;
  padding: .75rem 1.25rem;
  background: color-mix(in srgb, var(--background) 88%, transparent);
  backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--border);
}
.wordmark { font-family: var(--font-display); font-size: 1.375rem; line-height: 1; letter-spacing: -.01em; }
.topbar .sep { width: 1px; height: 1.25rem; background: var(--border); }
.topbar .path { font-family: var(--font-mono); font-size: .75rem; color: var(--muted-foreground); }
.spacer { flex: 1; }

.layout { display: grid; grid-template-columns: 20rem 1fr; gap: 1.25rem; padding: 1.25rem; align-items: start; }
@media (max-width: 60rem) { .layout { grid-template-columns: 1fr; } }

.sidebar { position: sticky; top: 4.25rem; }
.rule-list { list-style: none; margin: 0; padding: .5rem; display: flex; flex-direction: column; gap: .125rem; max-height: 60vh; overflow-y: auto; scrollbar-gutter: stable; }
.rule-list li button {
  width: 100%; display: flex; align-items: center; gap: .5rem;
  padding: .5rem .625rem; border: 0; border-radius: var(--radius);
  background: transparent; color: inherit; font: inherit; text-align: left;
}
.rule-list li button:hover { background: var(--muted); }
.rule-list li button[aria-current="true"] { background: color-mix(in srgb, var(--primary) 12%, transparent); }
.rule-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .8125rem; }
.rule-list .monitor { font-size: .625rem; color: var(--muted-foreground); text-transform: uppercase; letter-spacing: .04em; }

.section { border-top: 1px solid var(--border); padding-top: 1.25rem; margin-top: 1.25rem; }
.section:first-of-type { border-top: 0; padding-top: 0; margin-top: 0; }
.section-title { font-size: .6875rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted-foreground); margin: 0 0 .875rem; }

details.advanced > summary { font-size: .8125rem; color: var(--muted-foreground); list-style: none; padding: .5rem 0; }
details.advanced > summary::-webkit-details-marker { display: none; }
details.advanced > summary::before { content: "▸ "; }
details.advanced[open] > summary::before { content: "▾ "; }

.segmented { display: inline-flex; gap: .25rem; padding: .25rem; background: var(--muted); border-radius: var(--radius); flex-wrap: wrap; }
.segmented button {
  border: 0; background: transparent; color: var(--muted-foreground);
  font: inherit; font-size: .8125rem; font-weight: 500;
  padding: .3125rem .75rem; border-radius: calc(var(--radius) - 1px);
}
.segmented button[aria-pressed="true"] { background: var(--card); color: var(--foreground); box-shadow: 0 1px 2px rgb(0 0 0 / .08); }

.arg-row { display: grid; grid-template-columns: 12rem 1fr auto; gap: .5rem; align-items: start; margin-bottom: .5rem; }

.panel-tabs { display: flex; gap: .25rem; padding: .25rem; background: var(--muted); border-radius: var(--radius); width: fit-content; }
.panel-tabs button { border: 0; background: transparent; color: var(--muted-foreground); font: inherit; font-size: .8125rem; font-weight: 500; padding: .3125rem .875rem; border-radius: calc(var(--radius) - 1px); }
.panel-tabs button[aria-selected="true"] { background: var(--card); color: var(--foreground); box-shadow: 0 1px 2px rgb(0 0 0 / .08); }

pre.yaml { margin: 0; font-family: var(--font-mono); font-size: .75rem; line-height: 1.6; overflow-x: auto; background: var(--muted); border-radius: var(--radius); padding: .875rem; max-height: 26rem; }

.issues { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .375rem; }
.issues li { font-family: var(--font-mono); font-size: .75rem; color: var(--destructive); }

.muted { color: var(--muted-foreground); }
.meta { font-size: .75rem; color: var(--muted-foreground); }
.mono { font-family: var(--font-mono); }
.stack { display: flex; flex-direction: column; gap: .75rem; }
.row { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
.empty { padding: 2.5rem 1.25rem; text-align: center; color: var(--muted-foreground); font-size: .8125rem; }

table.changes { width: 100%; border-collapse: collapse; font-size: .8125rem; }
table.changes th { text-align: left; font-weight: 500; color: var(--muted-foreground); font-size: .6875rem; text-transform: uppercase; letter-spacing: .06em; padding: 0 .625rem .5rem 0; }
table.changes td { padding: .4375rem .625rem .4375rem 0; border-top: 1px solid var(--border); vertical-align: top; }
table.changes td.case { font-family: var(--font-mono); font-size: .75rem; }

.toast {
  position: fixed; right: 1.25rem; bottom: 1.25rem; z-index: 50;
  display: none; align-items: center; gap: .5rem;
  background: var(--popover); color: var(--popover-foreground);
  border: 1px solid var(--border); border-radius: var(--radius);
  padding: .625rem .875rem; box-shadow: var(--shadow-soft); font-size: .8125rem;
  max-width: 28rem;
}
.toast[data-open="true"] { display: flex; }
.toast[data-tone="error"] { border-color: color-mix(in srgb, var(--destructive) 45%, var(--border)); }
`;
