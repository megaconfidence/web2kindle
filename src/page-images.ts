import type { Page } from '@cloudflare/puppeteer';

const NETWORK_IDLE_TIMEOUT_MS = 5_000;
const SCROLL_TIMEOUT_MS = 8_000;
const IMAGE_TIMEOUT_MS = 8_000;
const PAGE_IMAGE_TIMEOUT_MS = 25_000;
const MAX_SCROLL_DISTANCE = 200_000;
const MAX_IMAGES_TO_WAIT = 500;
const MAX_IFRAMES_TO_LOAD = 50;
const IMAGE_CONCURRENCY = 25;
const IMAGE_QUANTUM_MS = 250;

interface PageImageState {
	imageCount: number;
	pageHeight: number;
}

function loadLazyImagesScript(startAtTop: boolean, timeout = SCROLL_TIMEOUT_MS): string {
	return `(async () => {
	const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
	const startedAt = Date.now();
	const viewportHeight = Math.max(window.innerHeight, 1);
	const step = Math.max(Math.floor(viewportHeight * 0.8), 600);
	let position = ${startAtTop ? '0' : `Math.max(0, Math.min(window.scrollY, ${MAX_SCROLL_DISTANCE}))`};
	let previousHeight = -1;
	let previousImageCount = -1;
	let stableChecks = 0;

	const eagerLoadMedia = () => {
		for (let index = 0; index < Math.min(document.images.length, ${MAX_IMAGES_TO_WAIT}); index += 1) {
			document.images[index].loading = 'eager';
		}
		const frames = document.querySelectorAll('iframe[loading="lazy"]');
		for (let index = 0; index < Math.min(frames.length, ${MAX_IFRAMES_TO_LOAD}); index += 1) frames[index].loading = 'eager';
	};
	const getPageHeight = () => Math.min(
		Math.max(document.scrollingElement?.scrollHeight ?? 0, document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
		${MAX_SCROLL_DISTANCE},
	);

	window.scrollTo({ left: 0, top: position, behavior: 'instant' });

	while (Date.now() - startedAt < ${timeout} && position < ${MAX_SCROLL_DISTANCE}) {
		eagerLoadMedia();
		const pageHeight = getPageHeight();
		const imageCount = document.images.length;
		const bottom = Math.max(0, pageHeight - viewportHeight);
		if (position >= bottom) {
			if (pageHeight === previousHeight && imageCount === previousImageCount) stableChecks += 1;
			else stableChecks = 0;
			previousHeight = pageHeight;
			previousImageCount = imageCount;
			if (stableChecks >= 3) break;
			await sleep(250);
			continue;
		}

		stableChecks = 0;
		position = Math.min(position + step, bottom, ${MAX_SCROLL_DISTANCE});
		window.scrollTo({ left: 0, top: position, behavior: 'instant' });
		await sleep(100);
	}

	return { imageCount: Math.min(document.images.length, ${MAX_IMAGES_TO_WAIT}), pageHeight: getPageHeight() };
})()`;
}

const GET_PAGE_IMAGE_STATE_SCRIPT = `(() => ({
	imageCount: Math.min(document.images.length, ${MAX_IMAGES_TO_WAIT}),
	pageHeight: Math.min(
		Math.max(document.scrollingElement?.scrollHeight ?? 0, document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
		${MAX_SCROLL_DISTANCE},
	),
}))()`;

const WAIT_FOR_IMAGES_SCRIPT = `(async () => {
	const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
	const deadline = Date.now() + ${IMAGE_TIMEOUT_MS};
	let expire;
	const expired = new Promise((resolve) => { expire = resolve; });
	const expiryTimeout = setTimeout(expire, ${IMAGE_TIMEOUT_MS});
	const waitForLoad = (image) => new Promise((resolve) => {
		const finish = () => {
			image.removeEventListener('load', finish);
			image.removeEventListener('error', finish);
			resolve();
		};
		image.addEventListener('load', finish, { once: true });
		image.addEventListener('error', finish, { once: true });
		expired.then(finish);
		if (image.complete) finish();
	});
	const getImages = () => {
		const images = [];
		for (let index = 0; index < Math.min(document.images.length, ${MAX_IMAGES_TO_WAIT}); index += 1) {
			images.push(document.images[index]);
		}
		return images;
	};
	const settleImages = async () => {
		const images = getImages();
		const sources = images.map((image) => image.currentSrc);
		for (const image of images) image.loading = 'eager';
		const loadPromises = images.map((image) => image.complete ? Promise.resolve() : waitForLoad(image));
		const activeWork = [];
		let nextImage = 0;
		const worker = async () => {
			while (nextImage < images.length && Date.now() < deadline) {
				const index = nextImage;
				nextImage += 1;
				const image = images[index];
				const work = (async () => {
				await Promise.race([loadPromises[index], expired]);
				if (image.naturalWidth <= 0 || typeof image.decode !== 'function') return;
				await Promise.race([image.decode().catch(() => undefined), expired]);
				})();
				activeWork.push(work);
				await Promise.race([work, sleep(${IMAGE_QUANTUM_MS}), expired]);
			}
		};
		const workers = Array.from({ length: Math.min(images.length, ${IMAGE_CONCURRENCY}) }, () => worker());
		await Promise.race([Promise.allSettled(workers), expired]);
		await Promise.race([Promise.allSettled(activeWork), expired]);

		const currentImages = getImages();
		return currentImages.length === images.length && currentImages.every((image, index) =>
			image === images[index] && image.complete && image.currentSrc === sources[index]
		);
	};

	try {
		for (let pass = 0; pass < 3 && Date.now() < deadline; pass += 1) {
			if (await settleImages()) break;
			await Promise.race([sleep(100), expired]);
		}
	} finally {
		window.scrollTo({ left: 0, top: 0, behavior: 'instant' });
		await Promise.race([sleep(100), expired]);
		if (window.scrollY !== 0) window.scrollTo({ left: 0, top: 0, behavior: 'instant' });
	}

	for (let pass = 0; pass < 2 && Date.now() < deadline; pass += 1) {
		if (await settleImages()) break;
		await Promise.race([sleep(100), expired]);
	}
	clearTimeout(expiryTimeout);
})()`;

function isPageImageState(value: unknown): value is PageImageState {
	if (typeof value !== 'object' || value === null) return false;
	const state = value as Partial<PageImageState>;
	return Number.isFinite(state.imageCount) && Number.isFinite(state.pageHeight);
}

export async function waitForPageImages(
	page: Pick<Page, 'emulateMediaType' | 'evaluate' | 'waitForNetworkIdle'>,
	mediaType?: 'print',
	timeout = PAGE_IMAGE_TIMEOUT_MS,
): Promise<void> {
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	const growthDeadline = Date.now() + Math.max(0, timeout - IMAGE_TIMEOUT_MS - 1_000);
	const readiness = (async () => {
		if (mediaType) await page.emulateMediaType(mediaType);
		let state = await page.evaluate(loadLazyImagesScript(true, Math.max(0, Math.min(SCROLL_TIMEOUT_MS, growthDeadline - Date.now()))));

		while (Date.now() < growthDeadline) {
			const networkTimeout = Math.max(1, Math.min(NETWORK_IDLE_TIMEOUT_MS, growthDeadline - Date.now()));
			try {
				await page.waitForNetworkIdle({ concurrency: 0, idleTime: 500, timeout: networkTimeout });
			} catch {
				// Persistent analytics requests must not prevent the bounded image readiness check.
			}
			const currentState = await page.evaluate(GET_PAGE_IMAGE_STATE_SCRIPT);
			if (!isPageImageState(state) || !isPageImageState(currentState)) break;
			if (currentState.pageHeight === state.pageHeight && currentState.imageCount === state.imageCount) break;
			const scrollTimeout = Math.max(0, Math.min(SCROLL_TIMEOUT_MS, growthDeadline - Date.now()));
			if (scrollTimeout === 0) break;
			state = await page.evaluate(loadLazyImagesScript(false, scrollTimeout));
		}

		await page.evaluate(WAIT_FOR_IMAGES_SCRIPT);
	})();
	const deadline = new Promise<never>((_resolve, reject) => {
		timeoutId = setTimeout(() => reject(new Error('Timed out waiting for page images to load')), timeout);
	});

	try {
		await Promise.race([readiness, deadline]);
	} finally {
		if (timeoutId !== undefined) clearTimeout(timeoutId);
	}
}
