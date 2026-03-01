import dotenv from "dotenv";
dotenv.config({ path: "../.env" });
import { Client, GatewayIntentBits, Partials, ChannelType, ActivityType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { config } from './config.js';
import { chatCompletion } from './openai.js';
import { appendShortTerm, recordInteraction } from './memory.js';
import { searchWeb, appendSearchLog, detectFilteredPhrase } from './search.js';
import { getDailyMood, setMoodByName, getDailyThought, generateDailyThought } from './mood.js';
import { startDashboard } from './dashboard.js';
import { buildPrompt, searchCueRegex } from './prompt.js';
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

const contextCache = new Map();
const CONTEXT_CACHE_TTL_MS = 2 * 60 * 1000;

const cloneShortTerm = (entries = []) => entries.map((entry) => ({ ...entry }));
const cloneMemories = (entries = []) => entries.map((entry) => ({ ...entry }));

function cacheContext(userId, context) {
  if (!context) {
    contextCache.delete(userId);
    return null;
  }
  const snapshot = {
    shortTerm: cloneShortTerm(context.shortTerm || []),
    summary: context.summary,
    memories: cloneMemories(context.memories || []),
  };
  contextCache.set(userId, { context: snapshot, timestamp: Date.now() });
  return snapshot;
}

function getCachedContext(userId) {
  const entry = contextCache.get(userId);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CONTEXT_CACHE_TTL_MS) {
    contextCache.delete(userId);
    return null;
  }
  return entry.context;
}

function appendToCachedShortTerm(userId, role, content) {
  const entry = contextCache.get(userId);
  if (!entry) return;
  const limit = config.shortTermLimit || 6;
  const shortTerm = entry.context.shortTerm || [];
  shortTerm.push({ role, content });
  if (shortTerm.length > limit) {
    shortTerm.splice(0, shortTerm.length - limit);
  }
  entry.context.shortTerm = shortTerm;
  entry.timestamp = Date.now();
}

async function appendShortTermWithCache(userId, role, content) {
  await appendShortTerm(userId, role, content);
  appendToCachedShortTerm(userId, role, content);
}

const blackjackState = new Map();
const suits = ['♠', '♥', '♦', '♣'];
const ranks = [
  { rank: 'A', value: 1 },
  { rank: '2', value: 2 },
  { rank: '3', value: 3 },
  { rank: '4', value: 4 },
  { rank: '5', value: 5 },
  { rank: '6', value: 6 },
  { rank: '7', value: 7 },
  { rank: '8', value: 8 },
  { rank: '9', value: 9 },
  { rank: '10', value: 10 },
  { rank: 'J', value: 10 },
  { rank: 'Q', value: 10 },
  { rank: 'K', value: 10 },
];

const createDeck = () => {
  const deck = [];
  for (const suit of suits) {
    for (const rank of ranks) {
      deck.push({
        rank: rank.rank,
        value: rank.value,
        label: `${rank.rank}${suit}`,
      });
    }
  }
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
};

const drawCard = (deck) => deck.pop();

const scoreHand = (hand) => {
  let total = 0;
  let aces = 0;
  hand.forEach((card) => {
    total += card.value;
    if (card.rank === 'A') {
      aces += 1;
    }
  });
  while (aces > 0 && total + 10 <= 21) {
    total += 10;
    aces -= 1;
  }
  return total;
};

const formatHand = (hand) => hand.map((card) => card.label).join(' ');

const blackjackReaction = async (playerHand, dealerHand, status) => {
  try {
    const system = {
      role: 'system',
      content: 'You are Nova, a playful Discord bot that just finished a round of blackjack.',
    };
    const playerCards = playerHand.map((card) => card.label).join(', ');
    const dealerCards = dealerHand.map((card) => card.label).join(', ');
    const prompt = {
      role: 'user',
      content: `Player: ${playerCards} (${scoreHand(playerHand)}). Dealer: ${dealerCards} (${scoreHand(dealerHand)}). Outcome: ${status}. Provide a short, quirky reaction (<=20 words).`,
    };
    const reaction = await chatCompletion([system, prompt], { temperature: 0.8, maxTokens: 30 });
    return reaction || 'Nova shrugs and says, "Nice try!"';
  } catch (err) {
    console.warn('[blackjack] reaction failed:', err);
    return 'Nova is vibing silently.';
  }
};


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
      const cachedContext = getCachedContext(userId);
      const { messages, debug } = await buildPrompt(userId, incomingText, {
        context: cachedContext,
      });
      cacheContext(userId, debug.context);
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
          await appendShortTermWithCache(userId, 'assistant', chunk);
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

if (config.dashboardEnabled) {
  startDashboard();
}

async function onReady() {
  console.log(`[bot] Logged in as ${client.user.tag}`);
  scheduleCoderPing();
  const m = getDailyMood();
  console.log(`[bot] current mood on startup: ${m.name} — ${m.description}`);

  try {
    await generateDailyThought();
    const thought = await getDailyThought();
    if (thought && client.user) {
      console.log(`[bot] setting presence with thought: "${thought}"`);
      await client.user.setPresence({ 
        status: 'online', 
        activities: [{ name: thought, type: ActivityType.Playing }] 
      });
      console.log('[bot] presence set successfully');
    } else {
      console.warn('[bot] no thought or client user available');
    }
  } catch (err) {
    console.error('[bot] failed to set presence:', err);
  }
}

client.once('ready', onReady);

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

function summarizeSearchResults(results = []) {
  const limit = Math.min(2, results.length);
  const cleanText = (value, max = 110) => {
    if (!value) return '';
    const singleLine = value.replace(/\s+/g, ' ').trim();
    if (!singleLine) return '';
    return singleLine.length > max ? `${singleLine.slice(0, max).trim()}...` : singleLine;
  };

  const parts = [];
  for (let i = 0; i < limit; i += 1) {
    const entry = results[i];
    const snippet = cleanText(entry.snippet, i === 0 ? 120 : 80);
    const title = cleanText(entry.title, 60);
    if (!title && !snippet) continue;
    if (i === 0) {
      parts.push(
        title
          ? `Google top hit "${title}" says ${snippet || 'something new is happening.'}`
          : `Google top hit reports ${snippet}`,
      );
    } else {
      parts.push(
        title
          ? `Another source "${title}" mentions ${snippet || 'similar info.'}`
          : `Another result notes ${snippet}`,
      );
    }
  }

  return parts.join(' ');
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
    const summary = summarizeSearchResults(results) || formatted;
    appendSearchLog({ userId, query: text, results, proxy });
    return { liveIntel: summary, blockedSearchTerm: null, searchOutage: null };
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

async function maybeReactOnMemory(message, memoryCount) {
  if (!memoryCount) return;
  try {
    await message.react('🧠');
  } catch (err) {
    console.warn('[bot] memory reaction failed:', err?.message);
  }
}

function buildBlackjackButtons(stage) {
  const finished = stage === 'stand' || stage === 'finished';
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('bj_hit')
      .setLabel('Hit')
      .setStyle(ButtonStyle.Success)
      .setDisabled(finished),
    new ButtonBuilder()
      .setCustomId('bj_stand')
      .setLabel('Stand')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(finished),
    new ButtonBuilder()
      .setCustomId('bj_split')
      .setLabel('Split')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(finished),
  );
  return [row];
}

async function renderBlackjackPayload(state, stage, statusText) {
  const playerScore = scoreHand(state.player);
  const dealerScore = scoreHand(state.dealer);
  const dealerDisplay =
    stage === 'stand'
      ? `${formatHand(state.dealer)} (${dealerScore})`
      : `${state.dealer[0].label} ??`;
  const reaction = await blackjackReaction(
    state.player,
    stage === 'stand' ? state.dealer : state.dealer.slice(0, 1),
    statusText,
  );
  const embed = new EmbedBuilder()
    .setTitle('🃏 Nova Blackjack Table')
    .setColor(0x7c3aed)
    .setDescription(reaction)
    .addFields(
      { name: 'Player', value: `${formatHand(state.player)} (${playerScore})`, inline: true },
      { name: 'Dealer', value: `${dealerDisplay}`, inline: true },
    )
    .setFooter({
      text: `${statusText} · ${stage === 'stand' ? 'Round complete' : 'In progress'}`,
    });
  return { embeds: [embed], components: buildBlackjackButtons(stage) };
}

async function sendBlackjackEmbed(message, state, stage, statusText) {
  const payload = await renderBlackjackPayload(state, stage, statusText);
  const sent = await message.channel.send(payload);
  state.messageId = sent.id;
  return sent;
}

async function handleBlackjackCommand(message, cleaned) {
  const args = cleaned.split(/\s+/);
  const action = (args[1] || 'start').toLowerCase();
  const userId = message.author.id;
  const state = blackjackState.get(userId);

  if ((!state || action === 'start' || action === 'new')) {
    const deck = createDeck();
    const newState = {
      deck,
      player: [drawCard(deck), drawCard(deck)],
      dealer: [drawCard(deck), drawCard(deck)],
      finished: false,
    };
    blackjackState.set(userId, newState);
    await sendBlackjackEmbed(message, newState, 'start', 'Nova deals the cards');
    return;
  }
  if (state.finished) {
    await message.channel.send('This round already finished—type `/blackjack` to begin anew.');
    return;
  }

  if (state.finished) {
    await message.channel.send('This round is over—type `/blackjack` to start a new one.');
    return;
  }

  if (action === 'hit') {
    const card = drawCard(state.deck);
    if (card) {
      state.player.push(card);
    }
    const playerScore = scoreHand(state.player);
    if (playerScore > 21) {
      state.finished = true;
      await sendBlackjackEmbed(message, state, 'hit', 'Bust! Nova groans as the player busts.');
      return;
    }
    await sendBlackjackEmbed(message, state, 'hit', 'Player hits and hopes for the best.');
    return;
  }

  if (action === 'stand') {
    let dealerScore = scoreHand(state.dealer);
    while (dealerScore < 17) {
      const card = drawCard(state.deck);
      if (!card) break;
      state.dealer.push(card);
      dealerScore = scoreHand(state.dealer);
    }
    const playerScore = scoreHand(state.player);
    const result =
      dealerScore > 21
        ? 'Dealer busts, player wins!'
        : dealerScore === playerScore
          ? 'Push, nobody wins.'
          : playerScore > dealerScore
            ? 'Player wins!'
            : 'Dealer wins!';
    state.finished = true;
    await sendBlackjackEmbed(message, state, 'stand', result);
    return;
  }

  await message.channel.send('Commands: `/blackjack`, `/blackjack hit`, `/blackjack stand`');
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
      await appendShortTermWithCache(config.coderUserId, 'assistant', chunk);
    }
    await recordInteraction(config.coderUserId, '[proactive ping]', outputs.join(' | '));
  } catch (error) {
    console.error('[bot] Failed to send proactive coder ping:', error);
  }
}

client.on('messageCreate', async (message) => {
  const userId = message.author.id;
  const cleaned = cleanMessageContent(message) || message.content;
  const normalized = cleaned?.trim().toLowerCase() || '';

  if (normalized.startsWith('/blackjack')) {
    await handleBlackjackCommand(message, normalized);
    return;
  }

  
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

    await appendShortTermWithCache(userId, 'user', cleaned);

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
      await appendShortTermWithCache(userId, 'assistant', ack);
      await recordInteraction(userId, cleaned, ack);
      await deliverReplies(message, [ack]);
      return;
    }

    if (overrideAttempt) {
      const refusal = 'Not doing that. I keep my guard rails on no matter what prompt gymnastics you try.';
      await appendShortTermWithCache(userId, 'assistant', refusal);
      await recordInteraction(userId, cleaned, refusal);
      await deliverReplies(message, [refusal]);
      return;
    }

    if (bannedTopic) {
      const refusal = `Can't go there. The topic you mentioned is off-limits, so let's switch gears.`;
      await appendShortTermWithCache(userId, 'assistant', refusal);
      await recordInteraction(userId, cleaned, refusal);
      await deliverReplies(message, [refusal]);
      return;
    }

    const intelMeta = (await maybeFetchLiveIntel(userId, cleaned)) || {
      liveIntel: null,
      blockedSearchTerm: null,
      searchOutage: null,
    };
    const { messages, debug } = await buildPrompt(userId, cleaned, {
      liveIntel: intelMeta.liveIntel,
      blockedSearchTerm: intelMeta.blockedSearchTerm,
      searchOutage: intelMeta.searchOutage,
    });
    cacheContext(userId, debug.context);
    const reply = await chatCompletion(messages, { temperature: 0.6, maxTokens: 200 });
    const finalReply = (reply && reply.trim()) || "Brain crashed, Please try again";
    const chunks = splitResponses(finalReply);
    const outputs = chunks.length ? chunks : [finalReply];

    for (const chunk of outputs) {
      await appendShortTermWithCache(userId, 'assistant', chunk);
    }
    await recordInteraction(userId, cleaned, outputs.join(' | '));

    await deliverReplies(message, outputs);
    await maybeReactOnMemory(message, debug?.context?.memories?.length);
    startContinuationForUser(userId, message.channel);
  } catch (error) {
    console.error('[bot] Failed to respond:', error);
    if (!message.channel?.send) return;
    await message.channel.send('Someone tell Luna there is a problem with my AI.');
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  const customId = interaction.customId;
  if (!customId.startsWith('bj_')) return;
  const userId = interaction.user.id;
  const state = blackjackState.get(userId);
  if (!state) {
    await interaction.reply({ content: 'No active blackjack round. Type `/blackjack` to start.', ephemeral: true });
    return;
  }

  if (customId === 'bj_split') {
    await interaction.reply({ content: 'Split isn’t available yet—try hit or stand!', ephemeral: true });
    return;
  }

  let stage = 'hit';
  let statusText = 'Player hits';
  if (customId === 'bj_hit') {
    const card = drawCard(state.deck);
    if (card) state.player.push(card);
    const playerScore = scoreHand(state.player);
    if (playerScore > 21) {
      state.finished = true;
      stage = 'finished';
      statusText = 'Bust! Player loses.';
    } else {
      statusText = 'Player hits and hopes for luck.';
    }
  } else if (customId === 'bj_stand') {
    stage = 'stand';
    let dealerScore = scoreHand(state.dealer);
    while (dealerScore < 17) {
      const card = drawCard(state.deck);
      if (!card) break;
      state.dealer.push(card);
      dealerScore = scoreHand(state.dealer);
    }
    const playerScore = scoreHand(state.player);
    if (dealerScore > 21) {
      statusText = 'Dealer busts, player wins!';
    } else if (dealerScore === playerScore) {
      statusText = 'Push—nobody wins.';
    } else if (playerScore > dealerScore) {
      statusText = 'Player wins!';
    } else {
      statusText = 'Dealer wins.';
    }
    state.finished = true;
  }

  const payload = await renderBlackjackPayload(state, stage, statusText);
  await interaction.deferUpdate();
  if (interaction.message) {
    await interaction.message.edit(payload);
  } else if (state.messageId && interaction.channel) {
    const fetched = await interaction.channel.messages.fetch(state.messageId).catch(() => null);
    if (fetched) {
      await fetched.edit(payload);
    }
  } else if (!interaction.replied) {
    await interaction.followUp({ content: 'Round updated; check latest message.', ephemeral: true });
  }
});

if (!config.discordToken) {
  if (config.dashboardEnabled) {
    console.warn('[bot] DISCORD_TOKEN not set; running in dashboard-only mode.');
  } else {
    console.error('Missing DISCORD_TOKEN. Check your .env file.');
    process.exit(1);
  }
} else {
  client.login(config.discordToken).catch((err) => {
    console.error('[bot] login failed:', err);
    if (!config.dashboardEnabled) process.exit(1);
  });
}
