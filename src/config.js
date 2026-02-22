import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const defaultMemoryDbFile = fileURLToPath(new URL('../data/memory.sqlite', import.meta.url));
const legacyMemoryFile = fileURLToPath(new URL('../data/memory.json', import.meta.url));

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
  coderUserId: process.env.CODER_USER_ID || null,
  maxCoderPingIntervalMs: 6 * 60 * 60 * 1000,
  shortTermLimit: 10,
  memoryDbFile: process.env.MEMORY_DB_FILE ? path.resolve(process.env.MEMORY_DB_FILE) : defaultMemoryDbFile,
  legacyMemoryFile,
  summaryTriggerChars: 3000,
  memoryPruneThreshold: 0.2,
  maxMemories: 200,
  relevantMemoryCount: 5,
};
