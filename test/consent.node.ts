import { describe, expect, it } from 'vitest';
import { dismissConsent } from '../src/consent';

interface FakeElement {
	tag: string;
	id?: string;
	className?: string;
	innerText?: string;
	height?: number;
	width?: number;
	display?: string;
	visible?: boolean;
	/** Text of the nearest `[role="dialog"]`-style container, or undefined when there is no generic container. */
	genericContainerText?: string;
	/** True when the nearest container names cookies or consent in its id, class, or label. */
	namedContainer?: boolean;
	clicked?: boolean;
	hiddenWith?: string[];
	style?: { setProperty: (property: string, value: string, priority?: string) => void };
}

function element(partial: Partial<FakeElement> & { tag: string }): FakeElement {
	const node: FakeElement = { height: 40, width: 120, visible: true, hiddenWith: [], ...partial };
	node.style = {
		setProperty: (property: string, value: string) => {
			node.hiddenWith?.push(`${property}:${value}`);
			if (property === 'display') node.display = value;
		},
	};
	return node;
}

interface DomOptions {
	bodyText?: string;
	framed?: boolean;
	host?: string;
	rootOverflow?: string;
}

const NAMED_CONTAINER_SELECTOR = '[id*="cookie" i]';
const GENERIC_CONTAINER_SELECTOR = '[role="dialog"]';
const CANDIDATE_PREFIX = 'button,';

function installDom(
	nodes: FakeElement[],
	matcher: (node: FakeElement, selector: string) => boolean,
	{ bodyText = '', framed = false, host = 'example.com', rootOverflow = 'visible' }: DomOptions = {},
) {
	const originals = {
		document: globalThis.document,
		getComputedStyle: globalThis.getComputedStyle,
		window: globalThis.window,
		location: globalThis.location,
	};
	const sharedWindow = {};
	const overflowForced: string[] = [];
	const root = {
		style: {
			setProperty: (property: string, value: string) => overflowForced.push(`${property}:${value}`),
		},
	};

	const decorate = (node: FakeElement) => ({
		...node,
		getBoundingClientRect: () => ({ width: node.width ?? 0, height: node.display === 'none' ? 0 : (node.height ?? 0) }),
		checkVisibility: () => node.visible !== false,
		closest: (selector: string) => {
			if (selector.includes(NAMED_CONTAINER_SELECTOR)) return node.namedContainer ? {} : null;
			if (selector.includes(GENERIC_CONTAINER_SELECTOR)) {
				return node.genericContainerText === undefined ? null : { innerText: node.genericContainerText };
			}
			return null;
		},
		click: () => {
			node.clicked = true;
		},
		style: node.style,
		get value() {
			return node.innerText;
		},
	});

	Object.assign(globalThis, {
		document: {
			documentElement: root,
			body: { ...root, innerText: bodyText },
			querySelectorAll: (selector: string) => nodes.filter((node) => matcher(node, selector)).map(decorate),
		},
		getComputedStyle: (element: unknown) => ({
			visibility: 'visible',
			display: 'block',
			opacity: '1',
			overflow: element === root || element === undefined ? rootOverflow : 'visible',
		}),
		window: framed ? { top: {}, self: {} } : { top: sharedWindow, self: sharedWindow },
		location: { host },
	});

	return { restore: () => Object.assign(globalThis, originals), overflowForced };
}

function fakePage(
	nodes: FakeElement[],
	matcher: (node: FakeElement, selector: string) => boolean,
	onEvaluate?: () => void,
	options?: DomOptions,
) {
	const overflowForced: string[] = [];
	const evaluate = async (script: string) => {
		onEvaluate?.();
		const dom = installDom(nodes, matcher, options);
		try {
			return new Function(`return ${script}`)();
		} finally {
			overflowForced.push(...dom.overflowForced);
			dom.restore();
		}
	};
	return { evaluate, frames: () => [{ evaluate }], overflowForced };
}

const byId = (node: FakeElement, selector: string) => selector === `#${node.id}`;
const byCandidate = (_node: FakeElement, selector: string) => selector.startsWith(CANDIDATE_PREFIX);

describe('consent dismissal', () => {
	it('clicks a known accept button such as OneTrust', async () => {
		const accept = element({ tag: 'button', id: 'onetrust-accept-btn-handler' });
		const page = fakePage([accept], byId);

		const clicked = await dismissConsent(page);

		expect(accept.clicked).toBe(true);
		expect(clicked).toContain('#onetrust-accept-btn-handler');
	});

	it('retries while the consent platform is still injecting its dialog', async () => {
		const accept = element({ tag: 'button', id: 'onetrust-accept-btn-handler' });
		let passes = 0;
		const page = fakePage(
			[accept],
			(node, selector) => passes > 2 && byId(node, selector),
			() => {
				passes += 1;
			},
		);

		const clicked = await dismissConsent(page);

		expect(accept.clicked).toBe(true);
		expect(clicked).toContain('#onetrust-accept-btn-handler');
	});

	it('falls back to accept text inside a named cookie container', async () => {
		const accept = element({ tag: 'button', innerText: 'Accept all cookies', namedContainer: true });
		const page = fakePage([accept], byCandidate);

		const clicked = await dismissConsent(page, 1);

		expect(accept.clicked).toBe(true);
		expect(clicked).toContain('text:Accept all cookies');
	});

	it('accepts a long consent label that a short cap would reject', async () => {
		const accept = element({ tag: 'button', innerText: 'I accept the use of cookies and similar technologies', namedContainer: true });
		const page = fakePage([accept], byCandidate);

		await dismissConsent(page, 1);

		expect(accept.clicked).toBe(true);
	});

	it('ignores reject buttons and buttons outside any consent container', async () => {
		const reject = element({ tag: 'button', innerText: 'Reject all', namedContainer: true });
		const unrelated = element({ tag: 'button', innerText: 'Accept' });
		const page = fakePage([reject, unrelated], byCandidate);

		const clicked = await dismissConsent(page, 1);

		expect(reject.clicked).toBeUndefined();
		expect(unrelated.clicked).toBeUndefined();
		expect(clicked).toEqual([]);
	});

	it('leaves a destructive confirmation dialog alone', async () => {
		const confirm = element({
			tag: 'button',
			innerText: 'Yes',
			genericContainerText: 'Permanently delete this saved article?',
		});
		const page = fakePage([confirm], byCandidate);

		await dismissConsent(page, 1);

		expect(confirm.clicked).toBeUndefined();
	});

	it('clicks inside a generic dialog only when its copy is about cookies', async () => {
		const accept = element({ tag: 'button', innerText: 'OK', genericContainerText: 'We use cookies to personalise content' });
		const page = fakePage([accept], byCandidate);

		await dismissConsent(page, 1);

		expect(accept.clicked).toBe(true);
	});

	it('clicks an accept button inside a consent iframe that has no consent-like container', async () => {
		const accept = element({ tag: 'button', innerText: "Yes, I'm happy" });
		const page = fakePage([accept], byCandidate, undefined, {
			framed: true,
			bodyText: 'We use cookies to improve your experience',
		});

		const clicked = await dismissConsent(page, 1);

		expect(accept.clicked).toBe(true);
		expect(clicked).toContain("text:Yes, I'm happy");
	});

	it('leaves accept-like buttons alone in an unrelated iframe', async () => {
		const unrelated = element({ tag: 'button', innerText: 'Accept' });
		const page = fakePage([unrelated], byCandidate, undefined, { framed: true, bodyText: 'Buy now with one click' });

		await dismissConsent(page, 1);

		expect(unrelated.clicked).toBeUndefined();
	});

	it('skips buttons hidden behind a transparent ancestor', async () => {
		const accept = element({ tag: 'button', innerText: 'Accept all cookies', namedContainer: true, visible: false });
		const page = fakePage([accept], byCandidate);

		await dismissConsent(page, 1);

		expect(accept.clicked).toBeUndefined();
	});

	it('hides a zero-height consent wrapper around a fixed banner', async () => {
		const shell = element({ tag: 'div', id: 'onetrust-consent-sdk', height: 0 });
		const page = fakePage([shell], byId);

		const result = await dismissConsent(page, 1);

		expect(shell.hiddenWith).toContain('display:none');
		expect(result).toContain('hidden:#onetrust-consent-sdk');
	});

	it('releases a class-based scroll lock after hiding a shell', async () => {
		const shell = element({ tag: 'div', id: 'onetrust-consent-sdk' });
		const page = fakePage([shell], byId, undefined, { rootOverflow: 'hidden' });

		await dismissConsent(page, 1);

		expect(page.overflowForced).toContain('overflow:visible');
	});

	it('honours the timeout when a page script never settles', async () => {
		const page = { evaluate: () => new Promise<never>(() => undefined), frames: () => [] };

		const start = Date.now();
		await expect(dismissConsent(page, 5, 300)).resolves.toEqual([]);
		expect(Date.now() - start).toBeLessThan(1_000);
	});

	it('stops clicking once one frame has accepted', async () => {
		const accept = element({ tag: 'button', id: 'onetrust-accept-btn-handler' });
		const evaluate = async (script: string) => {
			const dom = installDom([accept], byId);
			try {
				return new Function(`return ${script}`)();
			} finally {
				dom.restore();
			}
		};
		let clickPasses = 0;
		const countingEvaluate = async (script: string) => {
			if (script.includes('checkVisibility')) clickPasses += 1;
			return evaluate(script);
		};
		const page = { evaluate: countingEvaluate, frames: () => [{ evaluate: countingEvaluate }, { evaluate: countingEvaluate }] };

		await dismissConsent(page, 1);

		expect(clickPasses).toBe(1);
	});

	it('keeps working when one frame stalls', async () => {
		const shell = element({ tag: 'div', id: 'onetrust-consent-sdk' });
		const working = async (script: string) => {
			const dom = installDom([shell], byId);
			try {
				return new Function(`return ${script}`)();
			} finally {
				dom.restore();
			}
		};
		const stalled = () => new Promise<never>(() => undefined);
		const page = { evaluate: stalled, frames: () => [{ evaluate: stalled }, { evaluate: working }] };

		const result = await dismissConsent(page, 1);

		expect(result).toContain('hidden:#onetrust-consent-sdk');
	});

	it('never fails the render when the page rejects evaluation', async () => {
		const page = {
			evaluate: async () => {
				throw new Error('Execution context was destroyed');
			},
			frames: () => {
				throw new Error('detached');
			},
		};

		await expect(dismissConsent(page, 2, 500)).resolves.toEqual([]);
	});
});
