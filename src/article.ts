export const ARTICLE_FORMATS = ['epub', 'pdf'] as const;

export type ArticleFormat = (typeof ARTICLE_FORMATS)[number];

const CACHE_VERSION = 3;

export async function getArticleCacheKey(url: string, format: ArticleFormat): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url));
	const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');

	return `article:v${CACHE_VERSION}:${format}:${hash}`;
}

export function isAllowedSourceUrl(value: string): boolean {
	try {
		const url = new URL(value);
		if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;

		const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
		if (hostname === 'localhost' || hostname.endsWith('.localhost') || isPrivateIpAddress(hostname)) return false;

		return true;
	} catch {
		return false;
	}
}

function isPrivateIpAddress(hostname: string): boolean {
	if (hostname.includes(':')) {
		return (
			hostname === '::' ||
			hostname === '::1' ||
			hostname.startsWith('fc') ||
			hostname.startsWith('fd') ||
			/^fe[89ab]/.test(hostname) ||
			hostname.startsWith('::ffff:')
		);
	}

	const octets = hostname.split('.').map(Number);
	if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;

	const [first, second] = octets;
	return (
		first === 0 ||
		first === 10 ||
		first === 127 ||
		(first === 100 && second >= 64 && second <= 127) ||
		(first === 169 && second === 254) ||
		(first === 172 && second >= 16 && second <= 31) ||
		(first === 192 && second === 168) ||
		(first === 198 && (second === 18 || second === 19)) ||
		first >= 224
	);
}
