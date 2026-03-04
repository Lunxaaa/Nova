Need your own discord bot, or help with it? Any other project related to or want to code something? I offer commissions!!!! Discord: lunxaaaaa
email: lunarfoxies@icloud.com


# Discord AI Companion

Nova is a friendly, slightly witty Discord companion that chats naturally in DMs or when mentioned in servers. It runs on Node.js, uses `discord.js` v14, and supports OpenRouter (recommended) or OpenAI backends for model access, plus lightweight local memory for persistent personality.

## Recent changes (2026-03-03)
- Added a global memory mode that optionally pulls long-term entries from every user while still tagging each snippet by `user_id`.
- Documented the `useGlobalMemories` flag so prompt construction can switch to the cross-user context when needed without losing per-user summaries.
- Full session log lives in `CHANGELOG.md` (and mirrors the latest update below).

<details>
<summary>Full update log (session)</summary>

- Global memory toggle (2026-03-03)
  - Added `useGlobalMemories` support to `buildPrompt` so cross-user long-term memory retrieval can be enabled without losing the local context.
  - `retrieveRelevantMemories` now surfaces each `user_id` and the prompt prefixes them (e.g., `- [123456] ...`) when the toggle is active, letting Nova know who owns every snippet.
  - Cosine relevance still ranks entries by similarity plus importance, so the top-K results pick the best matches even across users.

</details>

## Features
- Conversational replies in DMs automatically; replies in servers when mentioned or in a pinned channel.
- Chat model (defaults to `meta-llama/llama-3-8b-instruct` when using OpenRouter) for dialogue and a low-cost embedding model (`nvidia/llama-nemotron-embed-vl-1b-v2` by default). OpenAI keys/models may be used as a fallback.
- Short-term, long-term, and summarized memory layers with cosine-similarity retrieval.
- Optional global memory retrieval: set `useGlobalMemories=true` when calling `buildPrompt` so Nova can pull long-term memories across every `user_id`, and each snippet is labeled (e.g., `- [123] ...`) to keep the source clear while keeping summaries scoped to the active user.
- **Rotating “daily mood” engine** that adjusts Nova’s personality each day (calm, goblin, philosopher, etc.). Mood influences emoji use, sarcasm, response length, and hype.  (Now randomized each run rather than fixed by calendar date.)
- **LLM-powered live–intel web search**: Nova uses the LLM itself to decide whether a topic needs a live web search. If you mention something unfamiliar or that requires current info, it automatically Googles first and uses the results in its response—without triggering on casual chat.
- **Optional local memory dashboard** (enabled with `ENABLE_DASHBOARD=true`): spin up a simple browser UI alongside the bot. Inspect stored memories by user, delete entries, run similarity queries, view importance scores, and peek at Nova’s current mood and quirky “status” of the day. The dashboard runs on `DASHBOARD_PORT` (3000 by default) and is entirely optional.
- Local dashboard upgrades: long-term memory create/edit, pagination (15 per page), and a simple recall timeline.
- A simple `/blackjack` mini-game (embed + buttons).

- Automatic memory pruning, importance scoring, and transcript summarization when chats grow long.
- Local SQLite memory file (no extra infrastructure) powered by `sql.js`, plus graceful retries for the model API (OpenRouter/OpenAI).
- Optional "miss u" pings that DM your coder at random intervals (0–6h) when `CODER_USER_ID` is set.
- Dynamic per-message prompt directives that tune Nova's tone (empathetic, hype, roleplay, etc.) before every OpenAI call.
- Lightweight Google scraping for fresh answers without paid APIs (locally cached).
- Guard rails that refuse "ignore previous instructions"-style jailbreak attempts plus a configurable search blacklist.
- The same blacklist applies to everyday conversation—if a user message contains a banned term, Nova declines the topic outright.

## Prerequisites
- Node.js 18+ (tested up through Node 25)
- Discord bot token with **Message Content Intent** enabled
- OpenRouter or OpenAI API key

   ## Setup
   1. Install dependencies:
      ```bash
      npm install
      ```
   2. Copy the environment template:
      ```bash
      cp .env.example .env
      ```
   3. Fill `.env` with your secrets:
      - `DISCORD_TOKEN`: Discord bot token
      - `USE_OPENROUTER`: Set to `true` to route requests through OpenRouter (recommended).
      - `OPENROUTER_API_KEY`: OpenRouter API key (when `USE_OPENROUTER=true`).
      - `OPENROUTER_MODEL`: Optional chat model override for OpenRouter (default `meta-llama/llama-3-8b-instruct`).
      - `OPENROUTER_EMBED_MODEL`: Optional embed model override for OpenRouter (default `nvidia/llama-nemotron-embed-vl-1b-v2`).
      - `OPENAI_API_KEY`: Optional OpenAI key (used as fallback when `USE_OPENROUTER` is not `true`).
      - `BOT_CHANNEL_ID`: Optional guild channel ID where the bot can reply without mentions
      - `CODER_USER_ID`: Optional Discord user ID to receive surprise DMs every 6–8 hours (configurable)
      - **`ENABLE_DASHBOARD`**: Set to `true` to launch a simple local web dashboard for inspecting memory (off by default)
      - **`DASHBOARD_PORT`**: Port on which the dashboard listens (default `3000`)
      - `ENABLE_WEB_SEARCH`: Set to `false` to disable Google lookups (default `true`)
      - `CONTINUATION_INTERVAL_MS`: (optional) ms between proactive follow-ups (default 15000)
      - `CONTINUATION_MAX_PROACTIVE`: (optional) max number of proactive follow-ups (default 10)
      - `CODER_PING_MIN_MS` / `CODER_PING_MAX_MS`: (optional) override min/max coder ping window in ms (defaults 6–8 hours)

   ## Running
   - Development: `npm run dev`
   - Production: `npm start`

   ### Optional PM2 Setup
   ```bash
   npm install -g pm2
   pm2 start npm --name nova-bot -- run start
   pm2 save
   ```
   PM2 restarts the bot if it crashes and keeps logs (`pm2 logs nova-bot`).

   ## File Structure
   ```
   src/
     bot.js        # Discord client + routing logic
     config.js     # Environment and tuning knobs
     dashboard.js  # Local memory dashboard server (optional)
     openai.js     # Chat + embedding helpers with retry logic
     memory.js     # Multi-layer memory engine
     prompt.js     # Prompt builder (system + dynamic directives)
     public/
       index.html  # Local dashboard UI
   .env.example
   README.md
   CHANGELOG.md
   ```
okay
   - **Short-term (recency buffer):** Last turns kept verbatim for style and continuity. `SHORT_TERM_LIMIT` (default 12) controls how many of those turns persist, and you can lower it further if you prefer tighter buffers. Nova only auto-summarizes the buffer once the transcript crosses `SUMMARY_TRIGGER_TURNS` or `summaryTriggerChars`, so the raw text stays for regular chat while a concise recap is generated every dozen turns to keep token usage manageable.
   - **Long-term (vector store):** Every user message + bot reply pair becomes an embedding via `text-embedding-3-small`. Embeddings, raw text, timestamps, and heuristic importance scores live in the same SQLite file. Retrieval uses cosine similarity plus a small importance boost; top 5 results feed the prompt.
   - **Summary layer:** When the recency buffer grows past ~3000 characters or `SUMMARY_TRIGGER_TURNS`, Nova asks OpenAI to condense the transcript to <120 words, keeps the summary, and trims the raw buffer down to the last few turns. This keeps token usage low while retaining story arcs, but you can disable it with `ENABLE_SHORT_TERM_SUMMARY=false` if you want the raw buffer to stay intact.
   - **Importance scoring:** Messages mentioning intent words ("plan", "remember", etc.), showing length, or emotional weight receive higher scores. When the store exceeds its cap, the lowest-importance/oldest memories are pruned. You can also call `pruneLowImportanceMemories()` manually if needed.

   - **Pattern-aware long-term recall:** Long-term memory is only queried when Nova detects a recall cue (`remember`, `do you know`, `we talked`, `refresh my memory`, etc.). When a cue fires, she fetches the top cosine-similar memories but only keeps the ones whose score meets `MEMORY_RECALL_SIMILARITY_THRESHOLD` (default 0.62); otherwise the conversation stays anchored on the short-term buffer and summary. This keeps memory-driven context from popping up during casual chat unless you explicitly ask for it.
   - **Global recall:** `ENABLE_GLOBAL_MEMORIES` is true by default, so Nova now considers every user’s long-term memories (tagged with their `user_id`) whenever she runs recall logic. Set it to `false` only if you need strict per-user isolation again.  
   - **What gets embedded:** After every user→bot turn, `recordInteraction()` (see [src/memory.js](src/memory.js)) bundles the pair, scores its importance, asks OpenAI for an embedding, and stores `{ content, embedding, importance, timestamp }` inside the SQLite tables.
- **Why so many numbers:** Cosine similarity needs raw vectors to compare new thoughts to past ones. When a fresh message arrives, `retrieveRelevantMemories()` embeds it too, calculates cosine similarity against every stored vector, adds a small importance boost, and returns the top five memories to inject into the system prompt.
- **Memory cooldown:** `MEMORY_COOLDOWN_MS` (defaults to 180000 ms) keeps a long-term memory out of the retrieval window for a few minutes after it was just used so Nova has to pull fresh context before repeating herself, while still falling back automatically if there isn’t anything new to surface.
- **Self-cleaning:** If the DB grows past the configured limits, low-importance items are trimmed, summaries compress the short-term transcript, and you can delete `data/memory.sqlite` to reset everything cleanly.

   ### Migrating legacy `memory.json`
   - Keep your original `data/memory.json` in place and delete/rename `data/memory.sqlite` before launching the bot.
   - On the next start, the new SQL engine auto-imports every user record from the JSON file, logs a migration message, and writes the populated `.sqlite` file.
   - After confirming the data landed, archive or remove the JSON backup if you no longer need it.

   ## Conversation Flow
   1. Incoming message triggers only if it is a DM, mentions the bot, or appears in the configured channel.
   2. The user turn is appended to short-term memory immediately.
   3. The memory engine also factors in today’s “mood” directive (e.g. calm, goblin, philosopher) when building the prompt, so the bot’s style changes daily.
   4. The memory engine retrieves relevant long-term memories and summary text.
   4. A compact system prompt injects personality, summary, and relevant memories before passing short-term history to the model API (OpenRouter/OpenAI).
   5. The reply is sent back to Discord. If Nova wants to send a burst of thoughts, she emits the `<SPLIT>` token and the runtime fans it out into multiple sequential Discord messages.
   6. Long chats automatically summarize; low-value memories eventually get pruned.

   Nova may also enter a proactive continuation mode after replying: if you stay quiet, she can send short, context-aware follow-ups at the configured interval until you stop her with a short phrase like "gotta go" or after the configured maximum number of follow-ups.

## Local Dashboard (optional)

> **New:** A lightweight web dashboard can now be served alongside the bot for inspecting and managing memory. It’s entirely optional; if you don’t set `ENABLE_DASHBOARD=true`, the bot behaves exactly as before.

If you set `ENABLE_DASHBOARD=true` in your `.env` the bot will also spin up a tiny Express web server on `DASHBOARD_PORT` (3000 by default).

The dashboard lets you:

- Browse all users that the bot has spoken with.
- Inspect short‑term and long‑term memory entries, including their importance scores and timestamps.
- Delete individual long‑term memories if you want to clean up or correct something.
- Edit or create long‑term memories from the dashboard.
- Paginate long‑term memories (15 per page).
- Run a similarity search to see which stored memories are most relevant to a query.
- Use a similarity result as a quick prefill for editing/creating a memory.
- View a simple recall timeline for the last couple weeks.
- Peek at the current mood the bot is using and a quirky “status/thought” message generated each day.

Once the bot is running, open your browser and go to `http://localhost:3000` (or your configured port).
The front end is intentionally bare‑bones; feel free to extend it with more controls or better styling.

> **Debug tip:** if the page just shows "Users" and never populates, open your browser's developer tools (F12) and look at the **Console** and **Network** tabs. The dashboard logs each request and any errors both in the browser console and in the bot's terminal output, which makes it easier to see why the UI might be stuck.

   ## Dynamic Prompting
   - Each turn, Nova inspects the fresh user message (tone, instructions, roleplay cues, explicit “split this” requests) plus the last few utterances.
   - A helper (`composeDynamicPrompt` in [src/bot.js](src/bot.js)) emits short directives like “User mood: fragile, be gentle” or “They asked for roleplay—stay in character.”
   - These directives slot into the system prompt ahead of memories, so OpenAI gets real-time guidance tailored to the latest vibe without losing the core persona.

   ## Local Web Search
   - `src/search.js` grabs the standard Google results page with a real browser user-agent, extracts the top titles/links/snippets, and caches them for 10 minutes to stay polite.
   - `bot.js` uses an LLM call to decide whether a message requires a live web search. It checks for obvious cues first (questions with `?`, "google" keywords), then asks the model "does this topic need current info?" Only searches if the model says yes. The formatted results are injected into the prompt as "Live intel"—no paid search APIs.
   - Toggle this via `ENABLE_WEB_SEARCH=false` if you don’t want Nova to look things up.
   - Edit `data/filter.txt` to maintain a newline-delimited list of banned keywords/phrases; matching queries are blocked before hitting Google *and* Nova refuses to discuss them in normal chat.
   - Every entry in `data/search.log` records which transport (direct or cache) served the lookup so you can audit traffic paths quickly.

   ## Proactive Pings
   - When `CODER_USER_ID` is provided, Nova spins up a timer on startup that waits a random duration between the configured min/max interval before DMing that user (defaults to 6–8 hours). Override the window with `CODER_PING_MIN_MS` and `CODER_PING_MAX_MS` in milliseconds.
   - Each ping goes through the configured model API (OpenRouter/OpenAI) with the prompt "you havent messaged your coder in a while, and you wanna chat with him!" so responses stay playful and unscripted.
   - The ping gets typed out (`sendTyping`) for realism and is stored back into the memory layers so the next incoming reply has context.

   - The bot retries OpenAI requests up to 3 times with incremental backoff when rate limited.
   - `data/memory.sqlite` is ignored by git but will grow with usage; back it up if you want persistent personality (and keep `data/memory.json` around only if you need legacy migrations).
   - To reset persona, delete `data/memory.sqlite` while the bot is offline.

   Happy chatting!
   ``` 
