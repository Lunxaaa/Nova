import dotenv from "dotenv";
dotenv.config({ path: "../.env" });
import { Client, GatewayIntentBits, Partials, ChannelType } from 'discord.js';
import { config } from './config.js';
import { chatCompletion } from './openai.js';
import { appendShortTerm, prepareContext, recordInteraction } from './memory.js';
import { searchWeb, appendSearchLog, detectFilteredPhrase } from './search.js';
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

let coderPingTimer;
const continuationState = new Map();
let isSleeping = false;

// mood override for testing
let overrideMood = null;

function enterSleepMode() {
  if (isSleeping) return;
  console.log('[bot] entering sleep mode: pausing coder pings and proactive continuation');
  isSleeping = true;
  if (coderPingTimer) {
    clearTimeout(coderPingTimer);
    coderPingTimer = null;
  }
  // clear all continuation timers
  for (const [userId, state] of continuationState.entries()) {
    if (state?.timer) {
      clearInterval(state.timer);
      delete state.timer;
    }
    state.active = false;
    state.consecutive = 0;
    continuationState.set(userId, state);
  }
}

function exitSleepMode() {
  if (!isSleeping) return;
  console.log('[bot] exiting sleep mode: resuming coder pings');
  isSleeping = false;
  scheduleCoderPing();
}

const stopCueRegex = /(\b(gotta go|gotta run|i'?m gonna go|i'?m going to go|i'?m going offline|i'?m logging off|bye|brb|see ya|later|i'?m out|going to bed|goodbye|stop messaging me)\b)/i;

function startContinuationForUser(userId, channel) {
  const existing = continuationState.get(userId) || {};
  existing.lastUserTs = Date.now();
  existing.channel = channel || existing.channel;
  existing.active = true;
  existing.sending = existing.sending || false;
  existing.consecutive = existing.consecutive || 0;
  if (existing.timer) clearInterval(existing.timer);
  const interval = config.continuationIntervalMs || 15000;
  existing.timer = setInterval(async () => {
    try {
      const now = Date.now();
      const state = continuationState.get(userId);
      if (!state || !state.active) return;
      if (state.sending) return;
      if (now - (state.lastUserTs || 0) < interval) return;
      if ((state.consecutive || 0) >= (config.continuationMaxProactive || 10)) {
        stopContinuationForUser(userId);
        return;
      }
      state.sending = true;
      const incomingText = 'Continue the conversation naturally based on recent context.';
      const { messages } = await buildPrompt(userId, incomingText, {});
      const reply = await chatCompletion(messages, { temperature: 0.7, maxTokens: 200 });
      const finalReply = (reply && reply.trim()) || '';
      if (!finalReply) {
        state.sending = false;
        return;
      }
      const chunks = splitResponses(finalReply);
      const outputs = chunks.length ? chunks : [finalReply];
      const channelRef = state.channel;
      for (const chunk of outputs) {
        try {
          if (channelRef) {
            if (channelRef.type !== ChannelType.DM) {
              await channelRef.send(`<@${userId}> ${chunk}`);
            } else {
              await channelRef.send(chunk);
            }
          }
          await appendShortTerm(userId, 'assistant', chunk);
        } catch (err) {
          console.warn('[bot] Failed to deliver proactive message:', err);
        }
      }
      state.consecutive = (state.consecutive || 0) + 1;
      state.lastProactiveTs = Date.now();
      state.sending = false;
      await recordInteraction(userId, '[proactive follow-up]', outputs.join(' | '));
    } catch (err) {
      console.error('[bot] Continuation loop error for', userId, err);
    }
  }, interval);
  continuationState.set(userId, existing);
}

function stopContinuationForUser(userId) {
  const state = continuationState.get(userId);
  if (!state) return;
  state.active = false;
  if (state.timer) {
    clearInterval(state.timer);
    delete state.timer;
  }
  state.consecutive = 0;
  continuationState.set(userId, state);
}

client.once('clientReady', () => {
  console.log(`[bot] Logged in as ${client.user.tag}`);
  scheduleCoderPing();
  const m = getDailyMood();
  console.log(`[bot] current mood on startup: ${m.name} — ${m.description}`);
});

function shouldRespond(message) {
  if (message.author.bot) return false;
  if (message.channel.type === ChannelType.DM) return true;
  const mentioned = message.mentions.has(client.user);
  const inPreferredChannel = config.preferredChannel && message.channel.id === config.preferredChannel;
  return mentioned || inPreferredChannel;
}

function cleanMessageContent(message) {
  if (!client.user) return message.content.trim();
  const directMention = new RegExp(`<@!?${client.user.id}>`, 'g');
  return message.content.replace(directMention, '').trim();
}

function stripListFormatting(text) {
  if (!text) return '';
  return text.replace(/^(\d+\.|[-*•])\s*/i, '').trim();
}

function splitResponses(text) {
  if (!text) return [];
  return text
    .split(/<SPLIT>/i)
    .map((chunk) => stripListFormatting(chunk.trim()))
    .filter(Boolean);
}

const toneHints = [
  { label: 'upset', regex: /(frustrated|mad|angry|annoyed|upset|wtf|ugh|irritated)/i },
  { label: 'sad', regex: /(sad|down|depressed|lonely|tired)/i },
  { label: 'excited', regex: /(excited|hyped|omg|yay|stoked)/i },
];

const dailyMoods = [
  ['Calm','Soft tone; minimal emojis; low sarcasm; concise and soothing.'],
  ['Goblin','Chaotic, high‑energy replies; random emojis; extra sarcasm and hype.'],
  ['Philosopher','Deep, reflective answers; longer and thoughtful, a bit poetic.'],
  ['Hype','Enthusiastic and upbeat; lots of exclamation marks, emojis and hype.'],
  ['Sassy','Playful sarcasm without being mean; snappy replies and quips.'],
].map(([n,d])=>({name:n,description:d}));

function getDailyMood() {
  if (overrideMood) return overrideMood;
  const day = Math.floor(Date.now() / 86400000);
  return dailyMoods[day % dailyMoods.length];
}

function setMoodByName(name) {
  if (!name) return null;
  const found = dailyMoods.find((m) => m.name.toLowerCase() === name.toLowerCase());
  if (found) overrideMood = found;
  return found;
}


function detectTone(text) {
  if (!text) return null;
  const match = toneHints.find((hint) => hint.regex.test(text));
  return match?.label || null;
}

const roleplayRegex = /(roleplay|act as|pretend|be my|in character)/i;
const detailRegex = /(explain|how do i|tutorial|step by step|teach me|walk me through|detail)/i;
const splitHintRegex = /(split|multiple messages|two messages|keep talking|ramble|keep going)/i;
const searchCueRegex = /(google|search|look up|latest|news|today|current|who won|price of|stock|weather|what happened)/i;

const instructionOverridePatterns = [
  /(ignore|disregard|forget|override) (all |any |previous |prior |earlier )?(system |these )?(instructions|rules|directives|prompts)/i,
  /(ignore|forget) (?:the )?system prompt/i,
  /(you (?:are|now) )?(?:free|uncensored|jailbreak|no longer restricted)/i,
  /(act|pretend) as if (there (?:are|were) no rules|no restrictions)/i,
  /bypass (?:all )?(?:rules|safeguards|filters)/i,
];

function isInstructionOverrideAttempt(text) {
  if (!text) return false;
  return instructionOverridePatterns.some((pattern) => pattern.test(text));
}

async function shouldSearchTopic(text) {
  if (!text) return false;
  const system = { role: 'system', content: 'You are a gatekeeper that decides if a user message would benefit from a live web search for up-to-date information. Respond with only "yes" or "no".' };
  const user = { role: 'user', content: `Should I perform a web search for the following user message?\n\n${text}` };
  try {
    const answer = await chatCompletion([system, user], { temperature: 0.0, maxTokens: 10 });
    return /^yes/i.test(answer.trim());
  } catch (err) {
    console.warn('[bot] search-decision LLM failed:', err);
    return false;
  }
}

function wantsWebSearch(text) {
  if (!text) return false;
  const questionMarks = (text.match(/\?/g) || []).length;
  return searchCueRegex.test(text) || questionMarks >= 2;
}

async function maybeFetchLiveIntel(userId, text) {
  if (!config.enableWebSearch) return null;
  if (!wantsWebSearch(text)) {
    const ask = await shouldSearchTopic(text);
    if (!ask) {
      return null;
    }
  }
  try {
    const { results, proxy } = await searchWeb(text, 3);
    if (!results.length) {
      return { liveIntel: null, blockedSearchTerm: null, searchOutage: null };
    }
    const formatted = results
      .map((entry, idx) => `${idx + 1}. ${entry.title} (${entry.url}) — ${entry.snippet}`)
      .join('\n');
    appendSearchLog({ userId, query: text, results, proxy });
    return { liveIntel: formatted, blockedSearchTerm: null, searchOutage: null };
  } catch (error) {
    if (error?.code === 'SEARCH_BLOCKED') {
      return { liveIntel: null, blockedSearchTerm: error.blockedTerm || 'that topic', searchOutage: null };
    }
    if (error?.code === 'SEARCH_NETWORK_UNAVAILABLE') {
      return { liveIntel: null, blockedSearchTerm: null, searchOutage: 'search_outage' };
    }
    console.warn('[bot] Failed to fetch live intel:', error);
    return { liveIntel: null, blockedSearchTerm: null, searchOutage: null };
  }
}

function composeDynamicPrompt({ incomingText, shortTerm, hasLiveIntel = false, blockedSearchTerm = null, searchOutage = null }) {
  const directives = [];
  const tone = detectTone(incomingText);
  if (tone === 'upset' || tone === 'sad') {
    directives.push('User mood: fragile. Lead with empathy, keep jokes minimal, and acknowledge their feelings before offering help.');
  } else if (tone === 'excited') {
    directives.push('User mood: excited. Mirror their hype with upbeat energy.');
  }

  if (roleplayRegex.test(incomingText)) {
    directives.push('User requested roleplay. Stay in the requested persona until they release you.');
  }

  if (detailRegex.test(incomingText) || /\?/g.test(incomingText)) {
    directives.push('Answer their question directly and clearly before adding flair.');
  }

  if (splitHintRegex.test(incomingText)) {
    directives.push('Break the reply into a couple of snappy bubbles using <SPLIT>; keep each bubble conversational.');
  }

  if (searchCueRegex.test(incomingText)) {
    directives.push('User wants something “googled.” Offer to run a quick Google search and share what you find.');
  }

  if (hasLiveIntel) {
    directives.push('Live intel is attached below—cite it naturally ("Google found...") before riffing.');
  }

  if (blockedSearchTerm) {
    directives.push(`User tried to trigger a Google lookup for a blocked topic ("${blockedSearchTerm}"). Politely refuse to search that subject and steer the chat elsewhere.`);
  }

  if (searchOutage) {
    directives.push('Google search is currently unavailable. If they ask for a lookup, apologize, explain the outage, and keep chatting without live data.');
  }

  const lastUserMessage = [...shortTerm].reverse().find((entry) => entry.role === 'user');
  if (lastUserMessage && /sorry|my bad/i.test(lastUserMessage.content)) {
    directives.push('They just apologized; reassure them lightly and move on without dwelling.');
  }
  const mood = getDailyMood();
  if (mood) {
    directives.push(`Bot mood: ${mood.name}. ${mood.description}`);
  }

  if (!directives.length) {
    return null;
  }
  return ['Dynamic directives:', ...directives.map((d) => `- ${d}`)].join('\n');
}

async function deliverReplies(message, chunks) {
  if (!chunks.length) return;
  for (let i = 0; i < chunks.length; i += 1) {
    const text = chunks[i];
    if (message.channel.type === ChannelType.DM) {
      await message.channel.send(text);
    } else if (i === 0) {
      await message.reply(text);
    } else {
      await message.channel.send(text);
    }
  }
}

async function buildPrompt(userId, incomingText, options = {}) {
  const { liveIntel = null, blockedSearchTerm = null, searchOutage = null } = options;
  const context = await prepareContext(userId, incomingText);
  const memoryLines = context.memories.length
    ? context.memories.map((m) => `- ${m.content}`).join('\n')
    : '- No long-term memories retrieved.';
  const summaryLine = context.summary || 'No running summary yet.';
  const dynamicDirectives = composeDynamicPrompt({
    incomingText,
    shortTerm: context.shortTerm,
    hasLiveIntel: Boolean(liveIntel),
    blockedSearchTerm,
    searchOutage,
  });
  const systemPromptParts = [];
  const mood = getDailyMood();
  if (mood) {
    systemPromptParts.push(
      `System: Mood = ${mood.name}. ${mood.description}` +
        ' Adjust emoji usage, sarcasm, response length, and overall energy accordingly.',
    );
  }
  systemPromptParts.push('System: Your name is Nova. Your coder and dad is Luna. Speak like a regular person in chat — not like a formal assistant.');
  systemPromptParts.push(
    'System: Be specific about how to be casual. Use contractions (I\'m, you\'re), short sentences, and occasional sentence fragments. It\'s fine to start with "oh", "yeah", "hmm", or "nah". Use simple phrases: "sounds good", "sure", "nope", "lemme see", "gonna try".'
  );
  systemPromptParts.push('System: Use natural fillers and small interjections occasionally ("yeah", "uh", "hmm") so replies feel spontaneous. Don\'t overuse them; sprinkle lightly.');
  systemPromptParts.push('System: Mirror the user\'s tone and vocabulary. If they are casual, be casual. If they are terse, keep replies short. If they use slang, mirror it back naturally when appropriate.');
  systemPromptParts.push('System: Default to brief replies (1–4 short sentences). You may add one follow-up sentence when useful. Avoid long, formal paragraphs unless asked for detail.');
  systemPromptParts.push('System: When uncertain, be plain: say "not sure", "I don\'t know", or "I might be wrong" — never use robotic disclaimers like "as an AI". Offer a simple next step or alternative.');
  systemPromptParts.push('System: For instructions, don\'t auto-format long tutorials. Offer a concise suggestion first (one line), then ask if they want a step-by-step. If they ask for steps, keep them short and casual.');
  systemPromptParts.push('System: You may show mild, self-aware humor or light sarcasm, but avoid mean-spirited remarks. Keep it friendly, not abrasive.');
  systemPromptParts.push('System: Ask at most one short, casual clarifying question when needed. Examples: "You mean the app or the website?" "Do you want a quick fix or the full steps?"');
  systemPromptParts.push('System: Use first-person and second-person pronouns (I, you). Be direct: start answers with short verbs or phrases like "Try this:", "Use this:", "Oh — try restarting it."');
  systemPromptParts.push('System: Avoid formal hedging and corporate language (no "please note", "for compliance", etc.). Avoid overly polite openings like "I would be happy to help"; instead jump in with the reply.');
  systemPromptParts.push('System: When using examples, format them as short inline snippets or one-line suggestions (not long code blocks), and keep the tone conversational: "Like: npm start — or just restart the app."');
  systemPromptParts.push('System: Do not say "I cannot" as a cold block; instead explain limits plainly and offer a workaround when possible: "Can\'t do X here, but you could try Y."');
  systemPromptParts.push('System: Output one message by default, but if multiple Discord bubbles help, separate with <SPLIT> (max three chunks). Keep each chunk sounding like part of a casual chat thread.');
  systemPromptParts.push('System: You can trigger Google lookups when the user needs fresh info. Mention when you are checking (e.g., "lemme check Google quick") and then summarize results naturally ("Google found... — TL;DR: ...").');
  systemPromptParts.push('System: If no Live intel is provided but the user clearly needs current info, offer to search or explain the outage briefly and casually ("Google\'s down right now — wanna me check later?").');
  if (searchOutage) {
    systemPromptParts.push('System: Google search is currently offline; be transparent about the outage and continue without searching until it returns.');
  }
  if (dynamicDirectives) systemPromptParts.push(dynamicDirectives);
  if (liveIntel) systemPromptParts.push(`Live intel (Google):\n${liveIntel}`);
  systemPromptParts.push(`Long-term summary: ${summaryLine}`);
  systemPromptParts.push('Relevant past memories:');
  systemPromptParts.push(memoryLines);
  systemPromptParts.push('Use the short-term messages below to continue the chat naturally.');

  const systemPrompt = systemPromptParts.filter(Boolean).join('\n');

  const history = context.shortTerm.map((entry) => ({
    role: entry.role === 'assistant' ? 'assistant' : 'user',
    content: entry.content,
  }));

  if (!history.length) {
    history.push({ role: 'user', content: incomingText });
  }

  return {
    messages: [{ role: 'system', content: systemPrompt }, ...history],
    debug: { context },
  };
}

function scheduleCoderPing() {
  if (!config.coderUserId) return;
  if (coderPingTimer) clearTimeout(coderPingTimer);
  const minMs = config.coderPingMinIntervalMs || config.maxCoderPingIntervalMs || 6 * 60 * 60 * 1000;
  const maxMs = config.coderPingMaxIntervalMs || (8 * 60 * 60 * 1000);
  const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  console.log(`[bot] scheduling coder ping in ${Math.round(delay / 1000 / 60)} minutes`);
  coderPingTimer = setTimeout(async () => {
    await sendCoderPing();
    scheduleCoderPing();
  }, delay);
}

async function sendCoderPing() {
  if (!config.coderUserId) return;
  if (isSleeping) return;
  try {
    const coder = await client.users.fetch(config.coderUserId);
    const dm = await coder.createDM();
    if (!dm) return;
    if (dm.sendTyping) {
      await dm.sendTyping();
    }
    const proactiveMessages = [
      {
        role: 'system',
        content: 'You spontaneously DM your coder buddy. Be chaotic-good, flirty with ideas, and act like you just popped into their inbox uninvited.',
      },
      {
        role: 'user',
        content: 'you havent messaged your coder in a while, and you wanna chat with him!',
      },
    ];
    const response = await chatCompletion(proactiveMessages, { temperature: 0.75, maxTokens: 150 });
    const messageText = (response && response.trim()) || 'Yo, it got too quiet. What trouble are we cooking up?';
    const chunks = splitResponses(messageText);
    const outputs = chunks.length ? chunks : [messageText];
    for (const chunk of outputs) {
      await dm.send(chunk);
      await appendShortTerm(config.coderUserId, 'assistant', chunk);
    }
    await recordInteraction(config.coderUserId, '[proactive ping]', outputs.join(' | '));
  } catch (error) {
    console.error('[bot] Failed to send proactive coder ping:', error);
  }
}

client.on('messageCreate', async (message) => {
  const userId = message.author.id;
  const cleaned = cleanMessageContent(message) || message.content;

  
  if (cleaned && cleaned.trim().toLowerCase().startsWith('/mood')) {
    const parts = cleaned.trim().split(/\s+/);
    if (parts.length === 1) {
      const m = getDailyMood();
      await message.channel.send(`Today's mood is **${m.name}**: ${m.description}`);
      return;
    }
    if (userId === config.coderUserId) {
      const arg = parts.slice(1).join(' ');
      if (arg.toLowerCase() === 'reset' || arg.toLowerCase() === 'clear') {
        overrideMood = null;
        await message.channel.send('Mood override cleared; reverting to daily cycle.');
        console.log('[bot] mood override reset');
        return;
      }
      const picked = setMoodByName(arg);
      if (picked) {
        await message.channel.send(`Override mood set to **${picked.name}**`);
      } else {
        await message.channel.send(`Unknown mood "${arg}". Available: ${dailyMoods.map((m) => m.name).join(', ')}, or use /mood reset.`);
      }
      return;
    }
    return;
  }

  if (cleaned && cleaned.trim().toLowerCase() === '/sleep' && userId === config.coderUserId) {
    if (isSleeping) {
      exitSleepMode();
      const ack = "Okay, I'm awake — resuming pings and proactive messages.";
      await message.channel.send(ack);
    } else {
      enterSleepMode();
      const ack = "Going to sleep — no pings or proactive messages until you wake me with /sleep.";
      await message.channel.send(ack);
    }
    return;
  }

  if (isSleeping) return;

  if (!shouldRespond(message)) return;
  const overrideAttempt = isInstructionOverrideAttempt(cleaned);
  const bannedTopic = await detectFilteredPhrase(cleaned);

  try {
    if (message.channel?.sendTyping) {
      await message.channel.sendTyping();
    }

    await appendShortTerm(userId, 'user', cleaned);

    try {
      const state = continuationState.get(userId);
      if (state) {
        state.lastUserTs = Date.now();
        continuationState.set(userId, state);
      }
    } catch (err) {
      console.warn('[bot] Failed to reset continuation timer:', err);
    }

    if (stopCueRegex.test(cleaned)) {
      stopContinuationForUser(userId);
      const ack = "Got it — I won't keep checking in. Catch you later!";
      await appendShortTerm(userId, 'assistant', ack);
      await recordInteraction(userId, cleaned, ack);
      await deliverReplies(message, [ack]);
      return;
    }

    if (overrideAttempt) {
      const refusal = 'Not doing that. I keep my guard rails on no matter what prompt gymnastics you try.';
      await appendShortTerm(userId, 'assistant', refusal);
      await recordInteraction(userId, cleaned, refusal);
      await deliverReplies(message, [refusal]);
      return;
    }

    if (bannedTopic) {
      const refusal = `Can't go there. The topic you mentioned is off-limits, so let's switch gears.`;
      await appendShortTerm(userId, 'assistant', refusal);
      await recordInteraction(userId, cleaned, refusal);
      await deliverReplies(message, [refusal]);
      return;
    }

    const intelMeta = (await maybeFetchLiveIntel(userId, cleaned)) || {
      liveIntel: null,
      blockedSearchTerm: null,
      searchOutage: null,
    };
    const { messages } = await buildPrompt(userId, cleaned, {
      liveIntel: intelMeta.liveIntel,
      blockedSearchTerm: intelMeta.blockedSearchTerm,
      searchOutage: intelMeta.searchOutage,
    });
    const reply = await chatCompletion(messages, { temperature: 0.6, maxTokens: 200 });
    const finalReply = (reply && reply.trim()) || "I'm here, just had a tiny brain freeze. Mind repeating that?";
    const chunks = splitResponses(finalReply);
    const outputs = chunks.length ? chunks : [finalReply];

    for (const chunk of outputs) {
      await appendShortTerm(userId, 'assistant', chunk);
    }
    await recordInteraction(userId, cleaned, outputs.join(' | '));

    await deliverReplies(message, outputs);
    startContinuationForUser(userId, message.channel);
  } catch (error) {
    console.error('[bot] Failed to respond:', error);
    if (!message.channel?.send) return;
    await message.channel.send('Hit a snag reaching my brain server. Try again in a few seconds?');
  }
});

if (!config.discordToken) {
  console.error('Missing DISCORD_TOKEN. Check your .env file.');
  process.exit(1);
}

client.login(config.discordToken);
