const API_ENDPOINT = 'https://web2kindle.megaconfidence.me/send';
// const API_ENDPOINT = 'http://localhost:8787/send';

const browser = window?.browser || window?.chrome;

// Get current tab URL using the Promise API shared by Firefox and modern Chrome.
const activeTab = browser?.tabs?.query({ currentWindow: true, active: true });
activeTab?.then((tabs) => {
	if (tabs[0]?.url) document.getElementById('url').value = tabs[0].url;
}, storageError);

// Load saved Kindle email from storage
browser.storage.local.get(['email', 'format']).then((store) => {
	document.getElementById('kindle-email').value = store?.email || '';
	document.getElementById('format').value = store?.format || 'epub';
}, storageError);

function storageError(error) {
	console.log(`Storage Error: ${error}`);
}

document.getElementById('sendToKindleForm').addEventListener('submit', function (e) {
	e.preventDefault();

	const url = document.getElementById('url').value;
	const kindleEmail = document.getElementById('kindle-email').value;
	const format = document.getElementById('format').value;
	const messageDiv = document.getElementById('message');
	const messageText = document.getElementById('messageText');

	// Save the user's delivery preferences locally in the extension.
	browser.storage.local.set({ email: kindleEmail, format }).then(() => console.log('preferences stored'), storageError);

	messageDiv.classList.remove('hidden');
	messageText.textContent = `Creating ${format.toUpperCase()}...`;
	messageText.className = 'text-sm text-gray-600';

	(async function () {
		try {
			const response = await fetch(API_ENDPOINT, {
				method: 'post',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ url, email: kindleEmail, format }),
			});
			if (response.ok) {
				messageText.textContent = `${format.toUpperCase()} is being sent to your Kindle!`;
				messageText.className = 'text-sm text-green-600';
			} else {
				messageText.textContent = 'Could not send article to your Kindle';
				messageText.className = 'text-sm text-red-600';
			}
		} catch (e) {
			messageText.textContent = e.message;
			messageText.className = 'text-sm text-red-600';
		}
	})();

	// Clear message
	setTimeout(() => {
		messageDiv.classList.add('hidden');
	}, 10000);
});
