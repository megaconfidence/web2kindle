import { describe, expect, it } from 'vitest';
import { waitForPageImages } from '../src/page-images';

describe('page image readiness', () => {
	it('eager-loads lazy media, scrolls the page, and decodes images before capture', async () => {
		const calls: string[] = [];
		const scrollPositions: number[] = [];
		let scrollY = 0;
		let scrollHeight = 1_200;
		let decoded = false;
		const image = {
			complete: false,
			decode: async () => {
				decoded = true;
			},
			loading: 'lazy',
			naturalWidth: 0,
			addEventListener: (type: string, listener: () => void) => {
				if (type !== 'load') return;
				setTimeout(() => {
					image.complete = true;
					image.naturalWidth = 640;
					listener();
				}, 5);
			},
			removeEventListener: () => undefined,
		};
		const frame = { loading: 'lazy' };
		const originalDocument = globalThis.document;
		const originalWindow = globalThis.window;

		Object.assign(globalThis, {
			document: {
				body: {
					get scrollHeight() {
						return scrollHeight;
					},
				},
				documentElement: {
					get scrollHeight() {
						return scrollHeight;
					},
				},
				images: [image],
				querySelectorAll: () => [frame],
				scrollingElement: {
					get scrollHeight() {
						return scrollHeight;
					},
				},
			},
			window: {
				innerHeight: 600,
				get scrollY() {
					return scrollY;
				},
				scrollTo: ({ top }: { top: number }) => {
					scrollY = top;
					scrollPositions.push(top);
					if (top === 600) scrollHeight = 1_800;
				},
			},
		});

		try {
			await waitForPageImages(
				{
					emulateMediaType: async (type?: string) => {
						calls.push(`media:${type}`);
					},
					evaluate: async (script: string) => {
						calls.push('evaluate');
						return new Function(`return ${script}`)();
					},
					waitForNetworkIdle: async () => {
						calls.push('network');
					},
				},
				'print',
			);
		} finally {
			Object.assign(globalThis, { document: originalDocument, window: originalWindow });
		}

		expect(calls).toEqual(['media:print', 'evaluate', 'network', 'evaluate', 'evaluate']);
		expect(image.loading).toBe('eager');
		expect(frame.loading).toBe('eager');
		expect(scrollPositions).toContain(600);
		expect(scrollPositions).toContain(1_200);
		expect(scrollPositions.at(-1)).toBe(0);
		expect(decoded).toBe(true);
	});

	it('continues to the image check when network idle times out', async () => {
		let evaluations = 0;
		await waitForPageImages({
			emulateMediaType: async () => undefined,
			evaluate: async () => {
				evaluations += 1;
			},
			waitForNetworkIdle: async () => {
				throw new Error('Timed out');
			},
		});

		expect(evaluations).toBe(3);
	});

	it('rescans the page when content grows while the network settles', async () => {
		const calls: string[] = [];
		let evaluation = 0;
		await waitForPageImages({
			emulateMediaType: async () => undefined,
			evaluate: async () => {
				evaluation += 1;
				calls.push(`evaluate:${evaluation}`);
				if (evaluation === 1) return { imageCount: 1, pageHeight: 1_000 };
				if (evaluation === 2) return { imageCount: 2, pageHeight: 2_000 };
				if (evaluation === 3) return { imageCount: 2, pageHeight: 2_000 };
				if (evaluation === 4) return { imageCount: 2, pageHeight: 2_000 };
			},
			waitForNetworkIdle: async () => {
				calls.push('network');
			},
		});

		expect(calls).toEqual(['evaluate:1', 'network', 'evaluate:2', 'evaluate:3', 'network', 'evaluate:4', 'evaluate:5']);
	});

	it('enforces a Worker-side deadline when page scripts do not resolve', async () => {
		await expect(
			waitForPageImages(
				{
					emulateMediaType: async () => undefined,
					evaluate: async () => new Promise(() => undefined),
					waitForNetworkIdle: async () => undefined,
				},
				undefined,
				10,
			),
		).rejects.toThrow('Timed out waiting for page images to load');
	});
});
