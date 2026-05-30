import { loadDotEnv } from './env.js';
import { loadConfig } from './config.js';
import { createSubscriptionFetcher } from './runtime.js';
import { aggregateSubscriptions, formatPlainSubscription } from './subscription.js';
import { sourcesForToken } from './source-url.js';

async function main() {
  loadDotEnv();

  const args = process.argv.slice(2);
  const plainOutput = args.includes('--plain');
  const token = args.find((arg) => !arg.startsWith('--'));
  if (!token) {
    throw new Error('Usage: npm run print -- <token> or npm run print:plain -- <token>');
  }

  const config = loadConfig();
  const runtime = await createSubscriptionFetcher(config);

  try {
    const result = await aggregateSubscriptions(sourcesForToken(config.sources, token), runtime.fetch);
    process.stdout.write(plainOutput ? formatPlainSubscription(result.links) : `${result.encoded}\n`);
  } finally {
    await runtime.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
