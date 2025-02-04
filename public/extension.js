const API_ENDPOINT = 'https://web2kindle.conflare.workers.dev/send';

const url = document.getElementById('url').value;
const kindleEmail = document.getElementById('kindle-email').value;
const messageDiv = document.getElementById('message');
const messageText = document.getElementById('messageText');
const browser = window?.browser || window?.chrome;

// Get current tab URL
browser?.tabs?.query({ currentWindow: true, active: true }, (tabs) => {
	document.getElementById('url').value = tabs[0].url;
});

// Load saved Kindle email from storage
document.getElementById('kindle-email').value = localStorage.getItem('kindleEmail');

document.getElementById('sendToKindleForm').addEventListener('submit', function (e) {
	e.preventDefault();
	// Save Kindle email to storage
	localStorage.setItem('kindleEmail', kindleEmail);

	// Simulate sending request
	messageDiv.classList.remove('hidden');
	messageText.textContent = 'Processing...';
	messageText.className = 'text-sm text-gray-600';

	(async function () {
		const response = await fetch(API_ENDPOINT, {
			method: 'post',
			body: JSON.stringify({ url, email: kindleEmail }),
		});
		console.log(response);
		if (response.status === 200) {
			messageText.textContent = 'Article successfully sent to your Kindle!';
			messageText.className = 'text-sm text-green-600';
		} else {
			messageText.textContent = 'Could not send article to your Kindle';
			messageText.className = 'text-sm text-red-600';
		}
	})();

	// Clear message
	setTimeout(() => {
		messageDiv.classList.add('hidden');
	}, 10000);
});
