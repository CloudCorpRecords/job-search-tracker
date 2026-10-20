# Job Search Tracker

Live dashboard of my job search and open-source contribution campaign: **https://cloudcorprecords.github.io/job-search-tracker/**

- **Job applications**: every application I've sent, with status, channel, comp and notes, plus activity by day and a breakdown by status.
- **Open-source PRs**: issues I've vetted and the PRs I've opened, by repo and pipeline stage.

Everything is searchable, filterable and sortable.

## How it updates

It's a static page with no build step and no backend. On every visit (and every 5 minutes while the page is open) it reads both Google Sheets as CSV in the browser, so new rows show up as soon as they're logged.

Data sources are set in [`config.js`](config.js):

- `jobsCsv` / `prsCsv`: a "Publish to web" CSV link (File → Share → Publish to web → pick the tab → CSV).
- Otherwise it falls back to the sheet ID, which works when the sheet is shared as "anyone with the link can view".
