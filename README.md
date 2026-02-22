# Discord AI Companion

Nova is a friendly, slightly witty Discord companion that chats naturally in DMs or when mentioned in servers. It runs on Node.js, uses `discord.js` v14, and leans on OpenAI's cost-efficient models plus lightweight local memory for persistent personality.

## Features
- Conversational replies in DMs automatically; replies in servers when mentioned or in a pinned channel.
- OpenAI chat model (`gpt-4o-mini` by default) for dialogue and `text-embedding-3-small` for memory.
- Short-term, long-term, and summarized memory layers with cosine-similarity retrieval.
- Automatic memory pruning, importance scoring, and transcript summarization when chats grow long.
- Local SQLite memory file (no extra infrastructure) powered by `sql.js`, plus graceful retries for OpenAI rate limits.
- Optional "miss u" pings that DM your coder at random intervals (0–6h) when `CODER_USER_ID` is set.
- Dynamic per-message prompt directives that tune Nova's tone (empathetic, hype, roleplay, etc.) before every OpenAI call.
- Lightweight Google scraping for fresh answers without paid APIs (locally cached).
- Guard rails that refuse "ignore previous instructions"-style jailbreak attempts plus a configurable search blacklist.
- The same blacklist applies to everyday conversation—if a user message contains a banned term, Nova declines the topic outright.

## Prerequisites
- Node.js 18+ (tested up through Node 25)
- Discord bot token with **Message Content Intent** enabled
- OpenAI API key

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
   - `OPENAI_API_KEY`: OpenAI key
   - `OPENAI_MODEL`: Optional chat model override (default `gpt-4o-mini`)
   - `OPENAI_EMBED_MODEL`: Optional embedding model (default `text-embedding-3-small`)
   - `BOT_CHANNEL_ID`: Optional guild channel ID where the bot can reply without mentions
   - `CODER_USER_ID`: Optional Discord user ID to receive surprise DMs every 0–6 hours
   - `ENABLE_WEB_SEARCH`: Set to `false` to disable Google lookups (default `true`)

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
  openai.js     # Chat + embedding helpers with retry logic
  memory.js     # Multi-layer memory engine
.env.example
README.md
```

- **Short-term (recency buffer):** Last 10 conversation turns kept verbatim for style and continuity. Stored per user inside `data/memory.sqlite`.
- **Long-term (vector store):** Every user message + bot reply pair becomes an embedding via `text-embedding-3-small`. Embeddings, raw text, timestamps, and heuristic importance scores live in the same SQLite file. Retrieval uses cosine similarity plus a small importance boost; top 5 results feed the prompt.
- **Summary layer:** When the recency buffer grows past ~3000 characters, Nova asks OpenAI to condense the transcript to <120 words, keeps the summary, and trims the raw buffer down to the last few turns. This keeps token usage low while retaining story arcs.
- **Importance scoring:** Messages mentioning intent words ("plan", "remember", etc.), showing length, or emotional weight receive higher scores. When the store exceeds its cap, the lowest-importance/oldest memories are pruned. You can also call `pruneLowImportanceMemories()` manually if needed.

- **Embedding math:** `text-embedding-3-small` returns 1,536 floating-point numbers for each text chunk. That giant array is a vector map of the message’s meaning; similar moments land near each other in 1,536-dimensional space.
- **What gets embedded:** After every user→bot turn, `recordInteraction()` (see [src/memory.js](src/memory.js)) bundles the pair, scores its importance, asks OpenAI for an embedding, and stores `{ content, embedding, importance, timestamp }` inside the SQLite tables.
- **Why so many numbers:** Cosine similarity needs raw vectors to compare new thoughts to past ones. When a fresh message arrives, `retrieveRelevantMemories()` embeds it too, calculates cosine similarity against every stored vector, adds a small importance boost, and returns the top five memories to inject into the system prompt.
- **Self-cleaning:** If the DB grows past the configured limits, low-importance items are trimmed, summaries compress the short-term transcript, and you can delete `data/memory.sqlite` to reset everything cleanly.

### Migrating legacy `memory.json`
- Keep your original `data/memory.json` in place and delete/rename `data/memory.sqlite` before launching the bot.
- On the next start, the new SQL engine auto-imports every user record from the JSON file, logs a migration message, and writes the populated `.sqlite` file.
- After confirming the data landed, archive or remove the JSON backup if you no longer need it.

## Conversation Flow
1. Incoming message triggers only if it is a DM, mentions the bot, or appears in the configured channel.
2. The user turn is appended to short-term memory immediately.
3. The memory engine retrieves relevant long-term memories and summary text.
4. A compact system prompt injects personality, summary, and relevant memories before passing short-term history to OpenAI.
5. The reply is sent back to Discord. If Nova wants to send a burst of thoughts, she emits the `<SPLIT>` token and the runtime fans it out into multiple sequential Discord messages.
6. Long chats automatically summarize; low-value memories eventually get pruned.

## Dynamic Prompting
- Each turn, Nova inspects the fresh user message (tone, instructions, roleplay cues, explicit “split this” requests) plus the last few utterances.
- A helper (`composeDynamicPrompt` in [src/bot.js](src/bot.js)) emits short directives like “User mood: fragile, be gentle” or “They asked for roleplay—stay in character.”
- These directives slot into the system prompt ahead of memories, so OpenAI gets real-time guidance tailored to the latest vibe without losing the core persona.

## Local Web Search
- `src/search.js` grabs the standard Google results page with a real browser user-agent, extracts the top titles/links/snippets, and caches them for 10 minutes to stay polite.
- `bot.js` detects when a question sounds “live” (mentions today/news/google/etc.) and injects the formatted snippets into the prompt as "Live intel". No paid APIs involved—it’s just outbound HTTPS from your machine.
- Toggle this via `ENABLE_WEB_SEARCH=false` if you don’t want Nova to look things up.
- Edit `data/filter.txt` to maintain a newline-delimited list of banned keywords/phrases; matching queries are blocked before hitting Google *and* Nova refuses to discuss them in normal chat.
- Every entry in `data/search.log` records which transport (direct or cache) served the lookup so you can audit traffic paths quickly.

## Proactive Pings
- When `CODER_USER_ID` is provided, Nova spins up a timer on startup that waits a random duration (anywhere from immediate to 6 hours) before DMing that user.
- Each ping goes through OpenAI with the prompt "you havent messaged your coder in a while, and you wanna chat with him!" so responses stay playful and unscripted.
- The ping gets typed out (`sendTyping`) for realism and is stored back into the memory layers so the next incoming reply has context.

- The bot retries OpenAI requests up to 3 times with incremental backoff when rate limited.
- `data/memory.sqlite` is ignored by git but will grow with usage; back it up if you want persistent personality (and keep `data/memory.json` around only if you need legacy migrations).
- To reset persona, delete `data/memory.sqlite` while the bot is offline.

Happy chatting!
