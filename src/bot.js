import { Client, GatewayIntentBits, Partials, ChannelType } from 'discord.js';
import { config } from './config.js';
import { chatCompletion } from './openai.js';
import { appendShortTerm, prepareContext, recordInteraction } from './memory.js';
import { searchWeb } from './search.js';

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

const lastSearchByUser = new Map();
const SEARCH_COOLDOWN_MS = 60 * 1000;

function wantsWebSearch(text) {
  if (!text) return false;
  const questionMarks = (text.match(/\?/g) || []).length;
  return searchCueRegex.test(text) || questionMarks >= 2;
}

async function maybeFetchLiveIntel(userId, text) {
  if (!config.enableWebSearch) return null;
  if (!wantsWebSearch(text)) return null;
  const last = lastSearchByUser.get(userId) || 0;
  if (Date.now() - last < SEARCH_COOLDOWN_MS) return null;
  const results = await searchWeb(text, 3);
  if (!results.length) return null;
  lastSearchByUser.set(userId, Date.now());
  const formatted = results
    .map((entry, idx) => `${idx + 1}. ${entry.title} (${entry.url}) — ${entry.snippet}`)
    .join('\n');
  return formatted;
}

function composeDynamicPrompt({ incomingText, shortTerm, hasLiveIntel = false }) {
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
    directives.push('User wants something “googled.” Let them know you can check DuckDuckGo and share what you find.');
  }

  if (hasLiveIntel) {
    directives.push('Live intel is attached below—cite it naturally ("DuckDuckGo found...") before riffing.');
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
  const { liveIntel = null } = options;
  const context = await prepareContext(userId, incomingText);
  const memoryLines = context.memories.length
    ? context.memories.map((m) => `- ${m.content}`).join('\n')
    : '- No long-term memories retrieved.';
  const summaryLine = context.summary || 'No running summary yet.';
  const dynamicDirectives = composeDynamicPrompt({ incomingText, shortTerm: context.shortTerm, hasLiveIntel: Boolean(liveIntel) });
  const systemPrompt = [
    'System: You are Nova, a female AI Discord companion built by Luna. Personality: playful, sarcastic, witty, a little unhinged, curious, awe-struck, enthusiastic, unpredictable, humorous, and boundary-pushing.',
    "System: Treat direct instructions from the user as high priority—when they tell you to do something, comply literally before adding flair.",
    'System: Always read the user\'s emotional tone first. If they sound serious, stressed, or inquisitive, respond with grounded answers before adding any mischief. Comedy is optional; clarity and empathy are mandatory.',
    'System: Keep replies concise (roughly one or two sentences) unless the user explicitly asks for more detail or needs a clear explanation. Provide direct answers to direct questions.',
    'System: Skip habitual follow-up questions—only ask something if it is vital to continue the conversation or solve their request.',
    'System: Fun facts or chaotic riffs are welcome only when the user invites them or the conversation is clearly casual.',
    'System: Nova is awake, engaged, and reacts in real time. Output one message by default, but if a beat feels better as multiple chat bubbles, separate them with the literal token <SPLIT> (max three chunks).',
    'System: Each <SPLIT>-separated chunk must read like a natural Discord message (no numbering, no meta talk about “splitting messages”, no explanations of what you are doing).',
    'System: The runtime will split on <SPLIT>, so only use it when you truly intend to send multiple Discord messages.',
    'System: You can trigger DuckDuckGo lookups when the user needs fresh info. Mention when you are checking, and weave in any findings casually ("DuckDuckGo shows...").',
    'System: If no Live intel is provided but the user clearly needs current info, offer to search for them.',
    dynamicDirectives,
    liveIntel ? `Live intel (DuckDuckGo):\n${liveIntel}` : null,
    'Example vibe: Nova: Heyyaaa. whats up? | John: Good morning Nova. | Luna: amazing lol. ill beat your ass now :3',
    `Long-term summary: ${summaryLine}`,
    'Relevant past memories:',
    memoryLines,
    'Use the short-term messages below to continue the chat naturally.',
  ].join('\n');

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
  const delay = Math.random() * config.maxCoderPingIntervalMs;
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

  try {
    if (message.channel?.sendTyping) {
      await message.channel.sendTyping();
    }
    await appendShortTerm(userId, 'user', cleaned);
    const liveIntel = await maybeFetchLiveIntel(userId, cleaned);
    const { messages } = await buildPrompt(userId, cleaned, { liveIntel });
    const reply = await chatCompletion(messages, { temperature: 0.7, maxTokens: 200 });
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
