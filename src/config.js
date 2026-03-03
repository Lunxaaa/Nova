import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const defaultMemoryDbFile = fileURLToPath(new URL('../data/memory.sqlite', import.meta.url));
const legacyMemoryFile = fileURLToPath(new URL('../data/memory.json', import.meta.url));

const requiredEnv = ['DISCORD_TOKEN'];
requiredEnv.forEach((key) => {
  if (!process.env[key]) {
    console.warn(`[config] Missing environment variable ${key}. Did you copy .env.example?`);
  }
});

export const config = {
  discordToken: process.env.DISCORD_TOKEN || '',
  useOpenRouter: true,
  openRouterKey: process.env.OPENROUTER_API_KEY || '',
  openrouterReferer: process.env.OPENROUTER_REFERER || '',
  openrouterTitle: process.env.OPENROUTER_TITLE || '',
  chatModel: process.env.OPENROUTER_MODEL || 'meta-llama/llama-3-8b-instruct',
  embedModel: process.env.OPENROUTER_EMBED_MODEL || 'nvidia/llama-nemotron-embed-vl-1b-v2',
  openrouterTimeoutMs: process.env.OPENROUTER_TIMEOUT_MS ? parseInt(process.env.OPENROUTER_TIMEOUT_MS, 10) : 30000,
  preferredChannel: process.env.BOT_CHANNEL_ID || null,
  enableWebSearch: process.env.ENABLE_WEB_SEARCH !== 'false',
  coderUserId: process.env.CODER_USER_ID || null,
  maxCoderPingIntervalMs: 6 * 60 * 60 * 1000,
  coderPingMinIntervalMs: process.env.CODER_PING_MIN_MS ? parseInt(process.env.CODER_PING_MIN_MS, 10) : 6 * 60 * 60 * 1000,
  coderPingMaxIntervalMs: process.env.CODER_PING_MAX_MS ? parseInt(process.env.CODER_PING_MAX_MS, 10) : 4.5 * 60 * 60 * 1000,
  shortTermLimit: process.env.SHORT_TERM_LIMIT ? parseInt(process.env.SHORT_TERM_LIMIT, 10) : 12,
  memoryDbFile: process.env.MEMORY_DB_FILE ? path.resolve(process.env.MEMORY_DB_FILE) : defaultMemoryDbFile,
  legacyMemoryFile,
  summaryTriggerChars: 2200,
  memoryPruneThreshold: 0.2,
  memoryCooldownMs: process.env.MEMORY_COOLDOWN_MS ? parseInt(process.env.MEMORY_COOLDOWN_MS, 10) : 3 * 60 * 1000,
  maxMemories: 8000,
  enableShortTermSummary: process.env.ENABLE_SHORT_TERM_SUMMARY !== 'false',
  relevantMemoryCount: 3,
  longTermFetchLimit: 120,
  // Optional local dashboard that runs alongside the bot. Enable with
  // `ENABLE_DASHBOARD=true` and customize port with `DASHBOARD_PORT`.
  dashboardEnabled: process.env.ENABLE_DASHBOARD === 'true',
  dashboardPort: process.env.DASHBOARD_PORT ? parseInt(process.env.DASHBOARD_PORT, 10) : 3000,
  // Proactive continuation settings: when a user stops replying, Nova can continue
  // the conversation every `continuationIntervalMs` milliseconds until the user
  // signals to stop or the `continuationMaxProactive` limit is reached.
  continuationIntervalMs: process.env.CONTINUATION_INTERVAL_MS ? parseInt(process.env.CONTINUATION_INTERVAL_MS, 10) : 10000,
  continuationMaxProactive: process.env.CONTINUATION_MAX_PROACTIVE ? parseInt(process.env.CONTINUATION_MAX_PROACTIVE, 10) : 10,
  openaiKey: process.env.OPENAI_API_KEY || '',
  openaiModel: process.env.OPENAI_MODEL || 'gpt-3.5-turbo',
  enableFallbackOpenAI: process.env.ENABLE_OPENAI_FALLBACK === 'true',
};
