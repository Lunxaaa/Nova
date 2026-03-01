import { config } from './config.js';

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function withRetry(fn, attempts = 3, delayMs = 1500) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;

      const status =
        err?.status ||
        (err?.response && err.response.status) ||
        err?.statusCode ||
        0;

      const code = err?.code || err?.name || '';

      const retryableNetworkCodes = [
        'UND_ERR_CONNECT_TIMEOUT',
        'ECONNRESET',
        'ETIMEDOUT',
        'ENOTFOUND',
        'ECONNREFUSED',
        'EAI_AGAIN',
      ];

      const isRetryableNetworkError =
        retryableNetworkCodes.includes(code);

      if (
        status === 429 ||
        status >= 500 ||
        isRetryableNetworkError
      ) {
        const backoff = delayMs * Math.pow(2, i);
        console.warn(
          `[openrouter] retry ${i + 1}/${attempts} after ${backoff}ms`
        );
        await sleep(backoff);
        continue;
      }

      break;
    }
  }

  throw lastErr;
}

function buildHeaders() {
  const headers = {
    Authorization: `Bearer ${config.openRouterKey}`,
    'Content-Type': 'application/json',
  };

  if (config.openrouterReferer)
    headers['HTTP-Referer'] = config.openrouterReferer;

  if (config.openrouterTitle)
    headers['X-OpenRouter-Title'] = config.openrouterTitle;

  return headers;
}

async function postJson(path, body) {
  const url = `https://openrouter.ai/api/v1${path}`;
  const headers = buildHeaders();

  const controller = new AbortController();
  const timeout = config.openrouterTimeoutMs || 30000;

  const timeoutId = setTimeout(() => {
    const e = new Error(`Request timed out after ${timeout}ms`);
    e.code = 'UND_ERR_CONNECT_TIMEOUT';
    controller.abort();
    throw e;
  }, timeout);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(
        `OpenRouter ${res.status} ${res.statusText}: ${text}`
      );
      err.status = res.status;
      throw err;
    }

    return res.json();
  } catch (err) {
    if (
      err.name === 'AbortError' ||
      err.message?.includes('timed out')
    ) {
      const e = new Error(`Connect Timeout Error after ${timeout}ms`);
      e.code = 'UND_ERR_CONNECT_TIMEOUT';
      throw e;
    }

    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function openAiFallbackChat(messages, options = {}) {
  if (!config.enableFallbackOpenAI || !config.openaiKey) {
    throw new Error('OpenAI fallback disabled or missing API key');
  }

  const {
    model = config.openaiModel || 'gpt-3.5-turbo',
    temperature = 0.7,
    maxTokens = 400,
  } = options;

  const res = await fetch(
    'https://api.openai.com/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.openaiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
      }),
    }
  );

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `OpenAI fallback failed: ${res.status} ${text}`
    );
  }

  const data = await res.json();

  return (
    data?.choices?.[0]?.message?.content ||
    ''
  );
}

export async function chatCompletion(messages, options = {}) {
  const {
    model = config.chatModel,
    temperature = 0.7,
    maxTokens = 400,
    fallback = true,
  } = options;

  try {
    const payload = {
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
    };

    const data = await withRetry(() =>
      postJson('/chat/completions', payload)
    );

    const choice = data?.choices?.[0];
    if (!choice) {
      throw new Error('Empty response from primary model');
    }
    const text =
      choice?.message?.content ?? choice?.text ?? '';
    if (typeof text === 'string') {
      const trimmed = text.trim();
      if (trimmed) {
        return trimmed;
      }
      return '';
    }
    return '';
  } catch (err) {
    console.warn(
      '[chatCompletion] primary model failed:',
      err?.message
    );

    if (!fallback) throw err;

    try {
      return await openAiFallbackChat(messages, options);
    } catch (fallbackErr) {
      console.error(
        '[chatCompletion] fallback model also failed:',
        fallbackErr?.message
      );
      throw fallbackErr;
    }
  }
}

export async function createEmbedding(text) {
  if (!text || !text.trim()) return [];

  const payload = {
    model: config.embedModel,
    input: text,
  };

  const data = await withRetry(() =>
    postJson('/embeddings', payload)
  );

  return data?.data?.[0]?.embedding || [];
}

export async function summarizeConversation(
  summarySoFar,
  transcriptChunk
) {
  const system = {
    role: 'system',
    content:
      'You compress Discord chats. Keep tone casual, capture facts, goals, and emotional state. Max 120 words.',
  };

  const prompt = `Existing summary (can be empty): ${
    summarySoFar || 'None'
  }\nNew messages:\n${transcriptChunk}`;

  const user = { role: 'user', content: prompt };

  return chatCompletion([system, user], {
    temperature: 0.4,
    maxTokens: 180,
  });
}
