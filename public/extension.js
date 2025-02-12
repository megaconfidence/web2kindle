const API_ENDPOINT = 'https://web2kindle.megaconfidence.me/send';
// const API_ENDPOINT = 'http://localhost:8787/send';

localStorage.setItem('foo', 'bar');
const browser = window?.browser || window?.chrome;

// Get current tab URL
browser?.tabs?.query({ currentWindow: true, active: true }, (tabs) => {
	document.getElementById('url').value = tabs[0].url;
});

// Load saved Kindle email from storage
browser.storage.local.get('email').then((store) => {
	document.getElementById('kindle-email').value = store?.email || '';
}, storageError);

function storageError(error) {
	console.log(`Storage Error: ${error}`);
}

document.getElementById('sendToKindleForm').addEventListener('submit', function (e) {
	e.preventDefault();

	const url = document.getElementById('url').value;
	const kindleEmail = document.getElementById('kindle-email').value;
	const messageDiv = document.getElementById('message');
	const messageText = document.getElementById('messageText');

	// Save Kindle email to storage
	browser.storage.local.set({ email: kindleEmail }).then(() => console.log('email stored'), storageError);
	localStorage.setItem('kindleEmail', kindleEmail);

	// Simulate sending request
	messageDiv.classList.remove('hidden');
	messageText.textContent = 'Processing...';
	messageText.className = 'text-sm text-gray-600';

	(async function () {
		try {
			const response = await fetch(API_ENDPOINT, {
				method: 'post',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ url, email: kindleEmail }),
			});
			if (response.status === 200) {
				messageText.textContent = 'Article is being sent to your Kindle!';
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
