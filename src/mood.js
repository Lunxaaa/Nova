import { chatCompletion } from './openai.js';
import { getDailyThoughtFromDb, saveDailyThought } from './memory.js';

const dailyMoods = [
  ['Calm','Soft tone; minimal emojis; low sarcasm; concise and soothing.'],
  ['Goblin','Chaotic, high‑energy replies; random emojis; extra sarcasm and hype.'],
  ['Philosopher','Deep, reflective answers; longer and thoughtful, a bit poetic.'],
  ['Hype','Enthusiastic and upbeat; lots of exclamation marks, emojis and hype.'],
  ['Sassy','Playful sarcasm without being mean; snappy replies and quips.'],
].map(([n,d])=>({name:n,description:d}));

let overrideMood = null;
let currentDailyMood = null;

function getTodayDate() {
  const d = new Date();
  return d.toISOString().split('T')[0];
}

function pickMood(){
  return dailyMoods[Math.floor(Math.random() * dailyMoods.length)];
}

function getDailyMood() {
  if (overrideMood) return overrideMood;
  if (!currentDailyMood) currentDailyMood = pickMood();
  return currentDailyMood;
}

function setMoodByName(name) {
  if (!name) return null;
  const found = dailyMoods.find((m) => m.name.toLowerCase() === name.toLowerCase());
  if (found) overrideMood = found;
  return found;
}

async function getDailyThought() {
  const today = getTodayDate();
  return await getDailyThoughtFromDb(today);
}

async function setDailyThought(thought) {
  const today = getTodayDate();
  await saveDailyThought(today, thought);
}

async function generateDailyThought() {
  const today = getTodayDate();
  
  const existingThought = await getDailyThoughtFromDb(today);
  if (existingThought) {
    console.log('[mood] using existing thought for today:', existingThought);
    return existingThought;
  }

  let newThought = null;
  try {
    const prompt =
      'Write a short (one sentence, <20 words, exactly 120 characters max) quirky Discord "nova status" that a friendly bot might use today.';
    const messages = [
      { role: 'system', content: 'You are Nova, a playful Discord AI companion.' },
      { role: 'user', content: prompt },
    ];
    const resp = await chatCompletion(messages, { temperature: 0.8, maxTokens: 40 });
    newThought = (resp && resp.trim()) || '';

    if (newThought.length > 120) {
      newThought = newThought.substring(0, 117) + '...';
    }
  } catch (err) {
    console.warn('[mood] failed to generate daily thought:', err);
  }
  
  if (!newThought) {
    const fallbacks = [
      'Vibing in the server like a code ghost.',
      'I swear I understand humans… probably.',
      'Got an error? I am the error.',
      'Just refreshed my cache and I feel alive.',
    ];
    newThought = fallbacks[Math.floor(Math.random() * fallbacks.length)];
  }

  await saveDailyThought(today, newThought);
  console.log('[mood] generated and saved new thought for today:', newThought);
  return newThought;
}

export { getDailyMood, setMoodByName, getDailyThought, setDailyThought, generateDailyThought, dailyMoods };
