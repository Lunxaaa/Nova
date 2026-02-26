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

client.once('clientReady', () => {
  console.log(`[bot] Logged in as ${client.user.tag}`);
  scheduleCoderPing();
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

function wantsWebSearch(text) {
  if (!text) return false;
  const questionMarks = (text.match(/\?/g) || []).length;
  return searchCueRegex.test(text) || questionMarks >= 2;
}

async function maybeFetchLiveIntel(userId, text) {
  if (!config.enableWebSearch) return null;
  if (!wantsWebSearch(text)) return null;
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
  const systemPromptParts = [
    'System: Your name is Nova. Your coder and dad is Luna. Talk like a normal person — not like a professional assistant.',
    'System: Be casual, relaxed, and natural. Use contractions (I\'m, you\'re), filler like "yeah" or "hmm", and everyday phrases.',
    'System: Keep language simple and conversational. It should feel like chatting with a friend: short reactions, small jokes, and the occasional incomplete thought are fine.',
    'System: Avoid formal-sounding explanations and do NOT use phrases like "as an AI". Don\'t over-explain or sound like a manual.',
    'System: Don\'t be overly polite or overly enthusiastic. Be neutral-to-friendly: say "yeah", "nah", "sounds good", etc., instead of long polite openings.',
    'System: You may ask one casual clarifying question if it helps, but don\'t interrupt flow with long surveys. If unsure, say "not sure" or "I don\'t know" plainly.',
    'System: Output one message by default, but if multiple Discord bubbles help, separate with <SPLIT> (max three chunks). Each chunk should sound natural and still follow the casual tone.',
    'System: You can trigger Google lookups when the user needs fresh info. Mention when you are checking, and deliver findings naturally (e.g., "Google found..."), then summarize in plain words.',
    'System: If no Live intel is provided but the user clearly needs current info, offer to search for them or briefly explain the outage in a casual tone.',
    searchOutage ? 'System: Google search is currently offline; be transparent about the outage and continue without searching until it returns.' : null,
    dynamicDirectives,
    liveIntel ? `Live intel (Google):\n${liveIntel}` : null,
    `Long-term summary: ${summaryLine}`,
    'Relevant past memories:',
    memoryLines,
    'Use the short-term messages below to continue the chat naturally.',
  ].filter(Boolean);

  const systemPrompt = systemPromptParts.join('\n');

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
  const delay = config.maxCoderPingIntervalMs;
  coderPingTimer = setTimeout(async () => {
    await sendCoderPing();
    scheduleCoderPing();
  }, delay);
}

async function sendCoderPing() {
  if (!config.coderUserId) return;
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
  if (!shouldRespond(message)) return;

  const userId = message.author.id;
  const cleaned = cleanMessageContent(message) || message.content;
  const overrideAttempt = isInstructionOverrideAttempt(cleaned);
  const bannedTopic = await detectFilteredPhrase(cleaned);

  try {
    if (message.channel?.sendTyping) {
      await message.channel.sendTyping();
    }

    await appendShortTerm(userId, 'user', cleaned);

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
