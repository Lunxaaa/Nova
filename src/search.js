import { load as loadHtml } from 'cheerio';
import { promises as fs } from 'fs';
import path from 'path';
import { ProxyAgent } from 'undici';
import { config } from './config.js';

const logFile = path.resolve('data', 'search.log');
const filterFile = path.resolve('data', 'filter.txt');

const cache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const FILTER_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const FREE_PROXY_LIST_URL = 'https://free-proxy-list.net/en/';
const PROXY_LINE_REGEX = /^\d{1,3}(?:\.\d{1,3}){3}:\d{2,5}$/;
const PROXY_REFRESH_MS = config.proxyPoolRefreshMs || 10 * 60 * 1000;
const PROXY_MAX_ATTEMPTS = Math.max(1, config.proxyPoolMaxAttempts || 5);

let cachedFilters = { terms: [], expires: 0 };
let proxyPool = [];
let proxyPoolExpires = 0;
let proxyCursor = 0;

function makeCacheKey(query) {
  return query.trim().toLowerCase();
}

function setCache(query, data) {
  const key = makeCacheKey(query);
  cache.set(key, { data, expires: Date.now() + CACHE_TTL_MS });
}

function getCache(query) {
  const key = makeCacheKey(query);
  const cached = cache.get(key);
  if (!cached) return null;
  if (Date.now() > cached.expires) {
    cache.delete(key);
    return null;
  }
  return cached.data;
}

function sanitizeText(text) {
  if (!text) return '';
  return text.replace(/\s+/g, ' ').trim();
}

function absoluteUrl(href) {
  if (!href) return '';
  if (href.startsWith('http')) return href;
  return `https://duckduckgo.com${href}`;
}

async function loadBlockedTerms() {
  if (Date.now() < cachedFilters.expires) {
    return cachedFilters.terms;
  }
  try {
    const raw = await fs.readFile(filterFile, 'utf-8');
    const terms = raw
      .split(/\r?\n/)
      .map((line) => line.trim().toLowerCase())
      .filter((line) => line && !line.startsWith('#'));
    cachedFilters = { terms, expires: Date.now() + FILTER_CACHE_TTL_MS };
    return terms;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('[search] Failed to read filter list:', error.message);
    }
    cachedFilters = { terms: [], expires: Date.now() + FILTER_CACHE_TTL_MS };
    return [];
  }
}

export async function detectFilteredPhrase(text) {
  return findBlockedTerm(text);
}

async function findBlockedTerm(query) {
  if (!query) return null;
  const lowered = query.toLowerCase();
  const terms = await loadBlockedTerms();
  return terms.find((term) => lowered.includes(term)) || null;
}

function createBlockedError(term) {
  const error = new Error('Search blocked by filter');
  error.code = 'SEARCH_BLOCKED';
  error.blockedTerm = term;
  return error;
}

function createProxyUnavailableError(reason) {
  const error = new Error(reason || 'Proxy network unavailable');
  error.code = 'SEARCH_PROXY_UNAVAILABLE';
  return error;
}

function normalizeProxyEntries(entries) {
  if (!entries?.length) return [];
  const seen = new Set();
  entries
    .map((line) => line.trim())
    .forEach((line) => {
      if (PROXY_LINE_REGEX.test(line) && !seen.has(line)) {
        seen.add(line);
      }
    });
  return Array.from(seen);
}

function removeProxyFromPool(proxy) {
  if (!proxy) return;
  proxyPool = proxyPool.filter((entry) => entry !== proxy);
  if (!proxyPool.length) {
    proxyPoolExpires = 0;
    proxyCursor = 0;
  }
}

async function fetchFreeProxyList() {
  const response = await fetch(FREE_PROXY_LIST_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36',
      Accept: 'text/html',
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch free-proxy-list.net feed (HTTP ${response.status})`);
  }
  const html = await response.text();
  const $ = loadHtml(html);
  const table = $('table.table.table-striped.table-bordered').first();
  const entries = [];
  table.find('tbody tr').each((_, row) => {
    const cells = $(row).find('td');
    if (!cells?.length) return undefined;
    const ip = $(cells[0]).text().trim();
    const port = $(cells[1]).text().trim();
    const anonymity = $(cells[4]).text().trim().toLowerCase();
    const https = $(cells[6]).text().trim().toLowerCase();
    if (ip && port && https === 'yes' && !anonymity.includes('transparent')) {
      entries.push(`${ip}:${port}`);
    }
    return undefined;
  });
  return normalizeProxyEntries(entries);
}

async function hydrateProxyPool() {
  let lastError = null;

  try {
    const verifiedProxies = await fetchFreeProxyList();
    if (!verifiedProxies.length) {
      throw new Error('free-proxy-list.net returned zero usable entries');
    }
    proxyPool = verifiedProxies;
    proxyPoolExpires = Date.now() + PROXY_REFRESH_MS;
    proxyCursor = 0;
    console.info(`[search] Loaded ${verifiedProxies.length} proxies from free-proxy-list.net`);
    return;
  } catch (error) {
    lastError = error;
    console.warn(`[search] Free proxy source failed: ${error.message}`);
  }

  throw createProxyUnavailableError(lastError?.message || 'Proxy list unavailable');
}

async function ensureProxyPool() {
  if (proxyPool.length && Date.now() < proxyPoolExpires) {
    return;
  }
  await hydrateProxyPool();
}

async function getProxyInfo() {
  await ensureProxyPool();
  if (!proxyPool.length) {
    throw createProxyUnavailableError('Proxy pool empty');
  }
  const proxy = proxyPool[proxyCursor % proxyPool.length];
  proxyCursor = (proxyCursor + 1) % proxyPool.length;
  return {
    proxy,
    agent: new ProxyAgent(`http://${proxy}`),
  };
}

async function fetchDuckDuckGoHtml(url, headers) {
  const maxAttempts = PROXY_MAX_ATTEMPTS;
  let lastError = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let proxyInfo = null;
    try {
      const options = { headers };
      proxyInfo = await getProxyInfo();
      options.dispatcher = proxyInfo.agent;
      const response = await fetch(url, options);
      if (!response.ok) {
        throw new Error(`DuckDuckGo request failed (${response.status})`);
      }
      const html = await response.text();
      return {
        html,
        proxy: proxyInfo?.proxy || null,
      };
    } catch (error) {
      lastError = error;
      if (proxyInfo?.proxy) {
        removeProxyFromPool(proxyInfo.proxy);
      }
    }
  }

  throw createProxyUnavailableError(lastError?.message || 'All proxies failed');
}

export async function searchWeb(query, limit = 3) {
  if (!query?.trim()) {
    return { results: [], proxy: null, fromCache: false };
  }
  const blockedTerm = await findBlockedTerm(query);
  if (blockedTerm) {
    throw createBlockedError(blockedTerm);
  }
  const cached = getCache(query);
  if (cached) {
    return { results: cached, proxy: 'cache', fromCache: true };
  }

  const params = new URLSearchParams({ q: query, kl: 'us-en' });
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    Accept: 'text/html',
  };

  let html;
  let proxyLabel = null;
  try {
    const { html: fetchedHtml, proxy } = await fetchDuckDuckGoHtml(`https://duckduckgo.com/html/?${params.toString()}`, headers);
    html = fetchedHtml;
    proxyLabel = proxy || 'proxy-unknown';
  } catch (error) {
    if (error?.code === 'SEARCH_PROXY_UNAVAILABLE') {
      throw error;
    }
    console.warn('[search] DuckDuckGo request failed:', error);
    return { results: [], proxy: null, fromCache: false };
  }
  const $ = loadHtml(html);
  const results = [];

  $('.result').each((_, el) => {
    if (results.length >= limit) return false;
    const title = sanitizeText($(el).find('.result__title').text());
    const href = absoluteUrl($(el).find('.result__url').attr('href'));
    const snippet = sanitizeText($(el).find('.result__snippet').text());
    if (title && href) {
      results.push({ title, url: href, snippet });
    }
    return undefined;
  });

  setCache(query, results);
  return { results, proxy: proxyLabel || 'proxy-unknown', fromCache: false };
}

export async function appendSearchLog({ userId, query, results, proxy }) {
  try {
    await fs.mkdir(path.dirname(logFile), { recursive: true });
    const timestamp = new Date().toISOString();
    const proxyTag = proxy || 'direct';
    const lines = [
      `time=${timestamp} user=${userId} proxy=${proxyTag} query=${JSON.stringify(query)}`,
      ...results.map((entry, idx) => `  ${idx + 1}. ${entry.title} :: ${entry.url} :: ${entry.snippet}`),
      '',
    ];
    await fs.appendFile(logFile, `${lines.join('\n')}`);
  } catch (error) {
    console.warn('[search] failed to append log', error);
  }
}
