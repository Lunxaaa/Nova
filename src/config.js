import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

dotenv.config();

const requiredEnv = ['DISCORD_TOKEN', 'OPENAI_API_KEY'];
requiredEnv.forEach((key) => {
  if (!process.env[key]) {
    console.warn(`[config] Missing environment variable ${key}. Did you copy .env.example?`);
  }
});

export const config = {
  discordToken: process.env.DISCORD_TOKEN || '',
  openAiKey: process.env.OPENAI_API_KEY || '',
  chatModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  embedModel: process.env.OPENAI_EMBED_MODEL || 'text-embedding-3-small',
  preferredChannel: process.env.BOT_CHANNEL_ID || null,
  enableWebSearch: process.env.ENABLE_WEB_SEARCH !== 'false',
  proxyPoolRefreshMs: Number(process.env.PROXY_POOL_REFRESH_MS || 10 * 60 * 1000),
  proxyPoolMaxAttempts: Number(process.env.PROXY_POOL_ATTEMPTS || 5),
  coderUserId: process.env.CODER_USER_ID || null,
  maxCoderPingIntervalMs: 6 * 60 * 60 * 1000,
  shortTermLimit: 10,
  memoryFile: fileURLToPath(new URL('../data/memory.json', import.meta.url)),
  summaryTriggerChars: 3000,
  memoryPruneThreshold: 0.2,
  maxMemories: 200,
  relevantMemoryCount: 5,
};
