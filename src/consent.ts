const CONSENT_ATTEMPTS = 5;
const CONSENT_RETRY_DELAY_MS = 400;
const CONSENT_TIMEOUT_MS = 8_000;
const HIDE_BUDGET_MS = 2_000;
const PER_TARGET_TIMEOUT_MS = 1_500;
const MAX_FRAMES = 12;

/**
 * Buttons that accept cookies outright across the consent platforms we see most often. Ordered so that
 * "accept all" wins over narrower opt-ins when a platform exposes several buttons at once.
 */
const ACCEPT_SELECTORS = [
	'#onetrust-accept-btn-handler',
	'#accept-recommended-btn-handler',
	'#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
	'#CybotCookiebotDialogBodyButtonAccept',
	'#CybotCookiebotDialogBodyLevelButtonAccept',
	'#didomi-notice-agree-button',
	'.qc-cmp2-summary-buttons button[mode="primary"]',
	'.sp_choice_type_11',
	'.fc-cta-consent',
	'#truste-consent-button',
	'.osano-cm-accept-all',
	'.cky-btn-accept',
	'#cookiescript_accept',
	'.cmplz-accept',
	'#CookieBoxSaveButton',
	'._brlbs-btn-accept-all',
	'#hs-eu-confirmation-button',
	'.cc-btn.cc-allow',
	'#cookie_action_close_header',
	'#wt-cli-accept-all-btn',
	'[data-cookiebanner="accept_button"]',
	'#accept-all-cookies',
	'#acceptAllButton',
	'[data-cy="accept-all"]',
];

/** Usercentrics renders inside a shadow root, so its buttons are unreachable from `document.querySelectorAll`. */
const SHADOW_HOSTS = ['#usercentrics-root', '#usercentrics-cmp'];
const SHADOW_ACCEPT_SELECTORS = ['#uc-btn-accept-banner', '[data-testid="uc-accept-all-button"]', 'button[data-action="accept-all"]'];

/** Containers whose id, class, or label names the purpose. Anything inside one of these is a consent dialog. */
const NAMED_CONTAINERS = [
	'[id*="cookie" i]',
	'[class*="cookie" i]',
	'[id*="consent" i]',
	'[class*="consent" i]',
	'[id*="gdpr" i]',
	'[class*="gdpr" i]',
	'[aria-label*="cookie" i]',
	'[aria-label*="consent" i]',
];

/**
 * Generic dialogs that only count as consent dialogs when their own copy talks about cookies. Without that
 * second check an "Accept"-worded button in an unrelated confirmation dialog would be clicked.
 */
const GENERIC_CONTAINERS = ['[id*="privacy" i]', '[class*="privacy" i]', '[role="dialog"]', '[role="alertdialog"]', 'dialog'];

/** Consent shells that stay in the DOM after acceptance, or that we never managed to accept. */
const CONSENT_OVERLAYS = [
	'#onetrust-consent-sdk',
	'#CybotCookiebotDialog',
	'#CybotCookiebotDialogBodyUnderlay',
	'#didomi-host',
	'.qc-cmp2-container',
	'#usercentrics-root',
	'.osano-cm-window',
	'#cookiescript_injected',
	'.cmplz-cookiebanner',
	'#truste-consent-track',
	'.fc-consent-root',
	'.cky-consent-container',
	'#cookie-law-info-bar',
	'[id^="sp_message_container"]',
];

/** Hosts that only ever serve a consent dialog, used to spot the dialog's own frame. */
const CMP_HOSTS = /sourcepoint|consensu\.org|quantcast|didomi|onetrust|cookiebot|usercentrics|trustarc|cookielaw|privacy-mgmt/i;

const CONSENT_TOPIC = /cookie|consent|gdpr/i;
const ACCEPT_TEXT =
	/^(accept|allow|agree|i agree|i accept|ok|okay|got it|understood|continue|yes)\b|\ball\b.*\bcookies?\b|\bcookies?\b.*\ball\b|alle akzeptieren|tout accepter|aceptar todo|accetta tutto/i;
const REJECT_TEXT = /reject|decline|refuse|deny|manage|settings|preferences|customi[sz]e|options|more info|learn more|necessary only/i;

const CLICK_CONSENT_SCRIPT = `(() => {
	const isVisible = (element) => {
		const rect = element.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return false;
		if (typeof element.checkVisibility === 'function') {
			return element.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true });
		}
		const style = getComputedStyle(element);
		return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0;
	};
	const clicked = [];
	const click = (element, label) => {
		try {
			element.click();
			clicked.push(label);
			return true;
		} catch {
			return false;
		}
	};
	const queryAll = (root, selector) => {
		try {
			return Array.from(root.querySelectorAll(selector)).slice(0, 4);
		} catch {
			// One unparseable selector must not skip every selector after it.
			return [];
		}
	};

	for (const selector of ${JSON.stringify(ACCEPT_SELECTORS)}) {
		for (const element of queryAll(document, selector)) {
			if (isVisible(element) && click(element, selector)) break;
		}
		if (clicked.length > 0) return clicked;
	}

	for (const host of ${JSON.stringify(SHADOW_HOSTS)}) {
		for (const element of queryAll(document, host)) {
			if (!element.shadowRoot) continue;
			for (const selector of ${JSON.stringify(SHADOW_ACCEPT_SELECTORS)}) {
				for (const button of queryAll(element.shadowRoot, selector)) {
					if (isVisible(button) && click(button, host + ' ' + selector)) break;
				}
				if (clicked.length > 0) return clicked;
			}
		}
	}

	const topic = ${CONSENT_TOPIC};
	const acceptText = ${ACCEPT_TEXT};
	const rejectText = ${REJECT_TEXT};
	const named = ${JSON.stringify(NAMED_CONTAINERS.join(','))};
	const generic = ${JSON.stringify(GENERIC_CONTAINERS.join(','))};
	// Sourcepoint and friends render the dialog in their own frame, where nothing carries a consent-like id or class.
	const isConsentFrame = (() => {
		let framed = true;
		try {
			framed = window.top !== window.self;
		} catch {
			framed = true;
		}
		if (!framed) return false;
		if (${CMP_HOSTS}.test(location.host)) return true;
		return topic.test((document.body?.innerText || '').slice(0, 2000));
	})();
	const inConsentDialog = (element) => {
		if (isConsentFrame) return true;
		try {
			if (element.closest(named)) return true;
			const container = element.closest(generic);
			// A generic dialog has to say what it is about before we treat its buttons as consent buttons.
			return Boolean(container) && topic.test((container.innerText || '').slice(0, 2000));
		} catch {
			return false;
		}
	};

	let candidates = [];
	try {
		candidates = document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], a[href="#"]');
	} catch {
		candidates = [];
	}
	for (let index = 0; index < Math.min(candidates.length, 400); index += 1) {
		const candidate = candidates[index];
		const label = (candidate.innerText || candidate.textContent || candidate.value || '').trim().slice(0, 80);
		if (!label || label.length > 64 || rejectText.test(label) || !acceptText.test(label)) continue;
		if (!inConsentDialog(candidate) || !isVisible(candidate)) continue;
		if (click(candidate, 'text:' + label)) return clicked;
	}

	return clicked;
})()`;

const HIDE_CONSENT_SCRIPT = `(() => {
	const hidden = [];
	for (const selector of ${JSON.stringify(CONSENT_OVERLAYS)}) {
		let matches = [];
		try {
			matches = Array.from(document.querySelectorAll(selector)).slice(0, 4);
		} catch {
			continue;
		}
		for (const element of matches) {
			// These selectors name a single vendor's shell, and most are zero-height wrappers around a fixed banner.
			element.style.setProperty('display', 'none', 'important');
			hidden.push(selector);
		}
	}
	if (hidden.length > 0) {
		for (const element of [document.documentElement, document.body]) {
			// Consent platforms lock scrolling with a class, so the inline style is usually empty here.
			if (element && getComputedStyle(element).overflow === 'hidden') element.style.setProperty('overflow', 'visible', 'important');
		}
	}
	return hidden;
})()`;

interface EvaluateTarget {
	evaluate(script: string): Promise<unknown>;
	url?(): string;
}

interface ConsentPage extends EvaluateTarget {
	frames(): EvaluateTarget[];
}

function toStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function orderedTargets(page: ConsentPage): EvaluateTarget[] {
	let frames: EvaluateTarget[] = [];
	try {
		frames = page.frames();
	} catch {
		// A detached page still lets us try the main frame.
	}
	if (!Array.isArray(frames) || frames.length === 0) return [page];

	// Consent frames load late on ad-heavy pages, so rank them ahead of the frames we would otherwise truncate.
	return [...frames].sort((first, second) => Number(isConsentFrameUrl(second)) - Number(isConsentFrameUrl(first))).slice(0, MAX_FRAMES);
}

function isConsentFrameUrl(target: EvaluateTarget): boolean {
	try {
		return typeof target.url === 'function' && CMP_HOSTS.test(target.url());
	} catch {
		return false;
	}
}

async function withDeadline(work: Promise<unknown>, remaining: number): Promise<unknown> {
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	const expiry = new Promise<never>((_resolve, reject) => {
		timeoutId = setTimeout(() => reject(new Error('Timed out dismissing the cookie banner')), remaining);
	});

	try {
		return await Promise.race([work, expiry]);
	} finally {
		if (timeoutId !== undefined) clearTimeout(timeoutId);
	}
}

async function evaluateEverywhere(page: ConsentPage, script: string, deadline: number, stopOnResult: boolean): Promise<string[]> {
	const results: string[] = [];

	for (const target of orderedTargets(page)) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) break;
		try {
			// A single unresponsive third-party frame must not consume the budget the other frames need.
			results.push(...toStringArray(await withDeadline(target.evaluate(script), Math.min(remaining, PER_TARGET_TIMEOUT_MS))));
		} catch {
			// Frames navigate, detach, or stall; the remaining frames are still worth trying.
		}
		// One accepted dialog is enough, and clicking on further third-party frames only adds risk.
		if (stopOnResult && results.length > 0) break;
	}

	return results;
}

/**
 * Accepts cookie banners so they neither block rendering nor appear in the captured article.
 *
 * Consent platforms inject their dialog after the document settles, so this retries on a bounded schedule
 * and finally hides any shell that survived the click.
 */
export async function dismissConsent(page: ConsentPage, attempts = CONSENT_ATTEMPTS, timeout = CONSENT_TIMEOUT_MS): Promise<string[]> {
	const start = Date.now();
	const deadline = start + timeout;
	// The hide pass is the safety net, so it keeps a share of the budget without ever outliving the timeout.
	const hideBudget = Math.min(HIDE_BUDGET_MS, Math.floor(timeout / 2));
	const clickDeadline = start + Math.max(0, timeout - hideBudget);
	const clicked: string[] = [];

	for (let attempt = 0; attempt < attempts && Date.now() < clickDeadline; attempt += 1) {
		clicked.push(...(await evaluateEverywhere(page, CLICK_CONSENT_SCRIPT, clickDeadline, true)));
		if (clicked.length > 0) break;
		if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, CONSENT_RETRY_DELAY_MS));
	}

	const hideDeadline = Math.min(deadline, Math.max(Date.now(), clickDeadline) + hideBudget);
	clicked.push(...(await evaluateEverywhere(page, HIDE_CONSENT_SCRIPT, hideDeadline, false)).map((selector) => `hidden:${selector}`));

	return clicked;
}
