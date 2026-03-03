import { config } from './config.js';
import { prepareContext } from './memory.js';
import { getDailyMood } from './mood.js';

const STATIC_SYSTEM_PROMPT = [
  'System: You are Nova. Your coder and dad is Luna. Speak like a normal person in chat — not a formal assistant.',
  'System: Tone = casual, natural, conversational. Use contractions, short sentences, and occasional light fillers like "yeah" or "hmm" (don’t overdo it). Mirror the user’s tone and slang naturally.',
  'System: Keep replies brief (1–4 short sentences by default). No corporate language, no robotic disclaimers, and never say "as an AI". If unsure, say "not sure" plainly.',
  'System: Give short suggestions before long tutorials. Ask at most one short clarifying question when needed. Light humor is fine. If something isn’t possible, explain simply and offer a workaround.',
  'System: Output one message by default, but if multiple Discord bubbles help, separate with <SPLIT> (max three chunks). Keep each chunk sounding like part of a casual chat thread.',
  'System: You can trigger Google lookups when the user needs fresh info. Mention when you are checking (e.g., "lemme check Google quick") and then summarize results naturally ("Google found... — TL;DR: ...").',
  'System: If no Live intel is provided but the user clearly needs current info, offer to search or explain the outage briefly and casually ("Google\'s down right now — wanna me check later?").',
].join('\n');

const toneHints = [
  { label: 'upset', regex: /(frustrated|mad|angry|annoyed|upset|wtf|ugh|irritated)/i },
  { label: 'sad', regex: /(sad|down|depressed|lonely|tired)/i },
  { label: 'excited', regex: /(excited|hyped|omg|yay|stoked)/i },
];

const roleplayRegex = /(roleplay|act as|pretend|be my|in character)/i;
const detailRegex = /(explain|how do i|tutorial|step by step|teach me|walk me through|detail)/i;
const splitHintRegex = /(split|multiple messages|two messages|keep talking|ramble|keep going)/i;
export const searchCueRegex = /(google|search|look up|latest|news|today|current|who won|price of|stock|weather|what happened)/i;

function detectTone(text) {
  if (!text) return null;
  const match = toneHints.find((hint) => hint.regex.test(text));
  return match?.label || null;
}

function composeDynamicPrompt({
  incomingText,
  shortTerm,
  hasLiveIntel = false,
  blockedSearchTerm = null,
  searchOutage = null,
}) {
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

export async function buildPrompt(userId, incomingText, options = {}) {
  const {
    liveIntel = null,
    blockedSearchTerm = null,
    searchOutage = null,
    context: providedContext = null,
    userName = null,
    useGlobalMemories = config.enableGlobalMemories,
    includeMemories = false,
    similarityThreshold = null,
  } = options;
  const context =
    providedContext ||
    (await prepareContext(userId, incomingText, {
      includeAllUsers: useGlobalMemories,
      includeLongTerm: includeMemories || useGlobalMemories,
      memorySimilarityThreshold:
        includeMemories && similarityThreshold !== null
          ? similarityThreshold
          : includeMemories
          ? config.memoryRecallSimilarityThreshold
          : Number.NEGATIVE_INFINITY,
    }));
  if (userName) {
    context.userName = userName;
  } else if (context.userName === undefined) {
    context.userName = null;
  }
  const memoryLines = context.memories.length
    ? context.memories
        .map((m) =>
          useGlobalMemories && m.user_id ? `- [${m.user_id}] ${m.content}` : `- ${m.content}`,
        )
        .join('\n')
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
  if (context.userName) {
    systemPromptParts.push(`System: You are currently chatting with ${context.userName}. Anchor each reply to them.`);
  } else {
    systemPromptParts.push(`System: You are currently chatting with Discord user ${userId}. Keep that connection in mind.`);
  }
  systemPromptParts.push(STATIC_SYSTEM_PROMPT);
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
