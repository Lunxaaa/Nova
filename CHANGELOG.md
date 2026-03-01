# Changelog

All notable changes made during this working session (March 1, 2026).

## Unreleased

### Token + performance optimizations
- Added `src/prompt.js` to centralize prompt construction (`buildPrompt`) and reduce repeated prompt-building logic.
- Added a short-lived in-memory context cache in `src/bot.js` to reuse prepared context across the continuation loop and normal replies.
- Reduced default memory/prompt sizes in `src/config.js`:
  - `shortTermLimit`: 10 -> 6
  - `summaryTriggerChars`: 3000 -> 2200
  - `relevantMemoryCount`: 5 -> 3
  - Added `longTermFetchLimit` (default 120)
- Limited long-term memory retrieval to a recent window before similarity scoring in `src/memory.js` (uses `longTermFetchLimit`).
- Summarized live web-search intel before injecting it into the prompt (keeps the payload shorter) in `src/bot.js`.
- Debounced memory DB persistence in `src/memory.js` to batch multiple writes (instead of exporting/writing on every mutation).

### Dashboard (local memory UI)
- Revamped the dashboard UI layout + styling in `src/public/index.html`.
- Added long-term memory create/edit support:
  - API: `POST /api/users/:id/long` in `src/dashboard.js`
  - Store: `upsertLongTerm()` in `src/memory.js`
- Added long-term memory pagination:
  - API: `GET /api/users/:id/long?page=&per=` returns `{ rows, total, page, per, totalPages }` via `getLongTermMemoriesPage()` in `src/memory.js`
  - UI: paging controls; long-term list shows 15 per page (`LONG_TERM_PER_PAGE = 15`)
- Added "search preview" UX in the dashboard to quickly reuse a similar memory result as an edit/create starting point ("Use this memory").
- Added a simple recall timeline:
  - API: `GET /api/users/:id/timeline?days=` in `src/dashboard.js`
  - Store: `getMemoryTimeline()` in `src/memory.js`
  - UI: lightweight bar chart in `src/public/index.html`

### Fixes
- Fixed dashboard long-term pagination wiring (`getLongTermMemoriesPage` import/usage) in `src/dashboard.js`.
- Fixed dashboard long-term "Edit" button behavior by wiring row handlers in `src/public/index.html`.
- Prevented button interactions from crashing the bot on late/invalid updates by deferring updates and editing the message in `src/bot.js`.

### Discord-side features
- Added a memory-aware reaction badge: bot reacts with `🧠` when long-term memories were injected into the prompt (`src/bot.js`).
- Added a lightweight blackjack mini-game:
  - Start via text trigger `/blackjack` (not a registered slash command).
  - Single-embed game UI with button components for actions (Hit / Stand; Split is present as a placeholder).
  - Improved interaction handling to avoid "Unknown interaction" crashes by deferring updates and editing the message (`src/bot.js`).

### Reliability / guardrails
- Relaxed the "empty response" guard in `src/openai.js`:
  - Still throws when the provider returns no choices.
  - If choices exist but content is blank, returns an empty string instead of forcing fallback (reduces noisy false-positive failures).

### Configuration / examples
- Updated `.env.example` to include `OPENAI_API_KEY`.
