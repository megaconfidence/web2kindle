import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		projects: [
			{
				plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.json' } })],
				test: { include: ['test/**/*.spec.ts'], name: 'workers' },
			},
			{
				test: { environment: 'node', include: ['test/*.node.ts'], name: 'node' },
			},
		],
	},
});
