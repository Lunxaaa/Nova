#!/usr/bin/env node
import { searchWeb } from '../src/search.js';

const sampleQueries = [
  'latest space telescope discoveries',
  'ocean temperature anomalies',
  'history of the marimba',
  'why do cats trill',
  'how do lichens survive',
  'largest desert bloom',
  'roman concrete durability',
  'origami engineering projects',
  'fossil fuel phaseout updates',
  'tree ring climate data'
];

const providedQuery = process.argv.slice(2).join(' ').trim();
const query = providedQuery || sampleQueries[Math.floor(Math.random() * sampleQueries.length)];

console.log(`Searching DuckDuckGo for: "${query}"\n`);

try {
  const { results, proxy, fromCache } = await searchWeb(query, 5);
  console.log(`Proxy used: ${proxy || 'none'}${fromCache ? ' (cache hit)' : ''}`);
  if (!results.length) {
    console.log('No results returned.');
    process.exit(0);
  }
  results.forEach((entry, idx) => {
    console.log(`${idx + 1}. ${entry.title}`);
    console.log(`   ${entry.url}`);
    if (entry.snippet) {
      console.log(`   ${entry.snippet}`);
    }
    console.log('');
  });
} catch (error) {
  console.error('Search failed:', error.message);
  if (error.code) {
    console.error('Error code:', error.code);
  }
  process.exit(1);
}
