const API_ENDPOINT = 'https://web2kindle.confidence.sh/send';
// const API_ENDPOINT = 'http://localhost:8787/send';

const browser = window?.browser || window?.chrome;

const urlInput = document.getElementById('url');
const emailInput = document.getElementById('kindle-email');
const formatSelect = document.getElementById('format');
const form = document.getElementById('sendToKindleForm');
const submitButton = document.getElementById('submit-button');
const submitLabel = document.getElementById('submit-label');
const submitSpinner = document.getElementById('submit-spinner');
const messageDiv = document.getElementById('message');
const messageText = document.getElementById('messageText');
const setupBanner = document.getElementById('setup-banner');
const setupHelp = document.getElementById('setup-help');
const formatHint = document.getElementById('format-hint');
const version = document.getElementById('version');

const FORMAT_HINTS = {
	epub: "EPUB adapts to your Kindle's font and layout settings.",
	pdf: 'PDF keeps the original page layout, so text stays at a fixed size.',
};

let hideTimer;

formatSelect.addEventListener('change', showFormatHint);

function showFormatHint() {
	formatHint.textContent = FORMAT_HINTS[formatSelect.value] ?? FORMAT_HINTS.epub;
}

// Get current tab URL using the Promise API shared by Firefox and modern Chrome.
const activeTab = browser?.tabs?.query({ currentWindow: true, active: true });
activeTab?.then((tabs) => {
	if (tabs[0]?.url) urlInput.value = tabs[0].url;
}, storageError);

// Read from the manifest so the footer cannot drift away from the published version.
showVersion();

// Load saved preferences, including whether the setup tip was dismissed.
loadPreferences();

function showVersion() {
	try {
		const manifest = browser?.runtime?.getManifest?.();
		if (manifest?.version) version.textContent = `v${manifest.version}`;
	} catch (error) {
		// The markup already carries the version as a fallback.
	}
}

function loadPreferences() {
	try {
		browser.storage.local.get(['email', 'format', 'setupDismissed']).then((store) => {
			emailInput.value = store?.email || '';
			formatSelect.value = store?.format || 'epub';
			showFormatHint();
			showSetupTip(!store?.setupDismissed, false);
		}, preferencesUnavailable);
	} catch (error) {
		preferencesUnavailable(error);
	}
}

// Without a stored choice the setup tip is the safer default, since it is what new users need.
function preferencesUnavailable(error) {
	storageError(error);
	showSetupTip(true, false);
}

function storageError(error) {
	console.log(`Storage Error: ${error}`);
}

/**
 * The tip starts hidden because the storage read is async, so it fades in rather than
 * appearing and then vanishing for people who already dismissed it.
 */
function showSetupTip(visible, animate) {
	setupBanner.hidden = !visible;
	setupHelp.hidden = visible;
	if (visible && animate) setupBanner.classList.add('fade-in');
}

function rememberSetupTip(visible) {
	showSetupTip(visible, true);
	storePreferences({ setupDismissed: !visible });
}

function storePreferences(values) {
	try {
		browser.storage.local.set(values).then(() => {}, storageError);
	} catch (error) {
		storageError(error);
	}
}

document.getElementById('dismiss-setup').addEventListener('click', () => {
	rememberSetupTip(false);
	setupHelp.focus();
});

setupHelp.addEventListener('click', () => {
	rememberSetupTip(true);
	emailInput.focus();
});

function setStatus(text, tone) {
	clearTimeout(hideTimer);
	messageDiv.classList.remove('hidden');
	messageText.textContent = text;
	messageText.className = `text-sm ${tone}`;
}

function setBusy(busy, format) {
	submitButton.disabled = busy;
	submitSpinner.classList.toggle('hidden', !busy);
	submitLabel.textContent = busy ? `Creating ${format}...` : 'Send to Kindle';
}

form.addEventListener('submit', async function (event) {
	event.preventDefault();
	if (submitButton.disabled) return;

	if (!form.checkValidity()) {
		form.reportValidity();
		return;
	}

	const url = urlInput.value;
	const kindleEmail = emailInput.value;
	const format = formatSelect.value;
	const label = format.toUpperCase();

	// Save the user's delivery preferences locally in the extension.
	storePreferences({ email: kindleEmail, format });

	setBusy(true, label);
	setStatus(`Creating ${label}...`, 'text-gray-600');

	try {
		const response = await fetch(API_ENDPOINT, {
			method: 'post',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ url, email: kindleEmail, format }),
		});
		if (response.ok) {
			setStatus(`${label} is being sent to your Kindle!`, 'text-green-600');
		} else {
			setStatus((await response.text()) || 'Could not send article to your Kindle', 'text-red-600');
		}
	} catch (error) {
		setStatus(error.message, 'text-red-600');
	} finally {
		setBusy(false, label);
		// Only starts once the request has settled, so the result is never hidden early.
		hideTimer = setTimeout(() => messageDiv.classList.add('hidden'), 10000);
	}
});
