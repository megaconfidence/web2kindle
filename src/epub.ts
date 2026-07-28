import { Readability } from '@mozilla/readability';
import { strToU8, zipSync, type Zippable } from 'fflate';
import { DOMParser } from 'linkedom/worker';

const MAX_IMAGES = 12;
const MAX_IMAGE_ATTEMPTS = 36;
const MAX_IMAGE_ATTEMPTS_PER_ELEMENT = 4;
export const MAX_EMBEDDED_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_ARTICLE_CHARS = 3 * 1024 * 1024;
const MAX_DOM_ELEMENTS = 100_000;
const MAX_RESPONSIVE_IMAGE_WIDTH = 1600;
const MAX_LEAD_IMAGE_SCAN = 200;
const MAX_LEAD_IMAGE_CANDIDATES = 20;
const MIN_LEAD_IMAGE_DIMENSION = 200;
// Regions that hold promos, related posts, and site furniture rather than the image that opens the article.
const LEAD_IMAGE_EXCLUDED_REGIONS = 'nav, aside, footer, form';
// Matched as a whole word so that "iconic" or "logotype" cannot disqualify a real lead image. "placeholder"
// is deliberately absent: sites name the real image things like "image-placeholder-media", and genuine
// placeholders are already excluded by aria-hidden or by having no usable source.
const NON_CONTENT_IMAGE = /(?:^|[-_\s])(?:avatar|logo|icon|badge|sprite|emoji|tracking|pixel|spinner|thumbnail)(?:$|[-_\s])/i;
export const MAX_HTML_CHARS = 6 * 1024 * 1024;
export const MAX_EPUB_BYTES = 20 * 1024 * 1024;
export const MAX_DATA_IMAGE_PAYLOAD_CHARS = Math.ceil((MAX_EMBEDDED_IMAGE_BYTES * 4) / 3) + 4;

const DATA_IMAGE_MEDIA_TYPES = new Set(['image/gif', 'image/jpeg', 'image/jpg', 'image/png', 'image/webp']);

const ALLOWED_TAGS = new Set([
	'a',
	'abbr',
	'address',
	'article',
	'b',
	'blockquote',
	'br',
	'caption',
	'cite',
	'code',
	'dd',
	'del',
	'details',
	'div',
	'dl',
	'dt',
	'em',
	'figcaption',
	'figure',
	'h1',
	'h2',
	'h3',
	'h4',
	'h5',
	'h6',
	'hr',
	'i',
	'img',
	'kbd',
	'li',
	'mark',
	'ol',
	'p',
	'pre',
	'q',
	's',
	'samp',
	'section',
	'small',
	'span',
	'strong',
	'sub',
	'summary',
	'sup',
	'table',
	'tbody',
	'td',
	'tfoot',
	'th',
	'thead',
	'time',
	'tr',
	'u',
	'ul',
]);

const BLOCKED_TAGS = new Set([
	'audio',
	'button',
	'canvas',
	'embed',
	'form',
	'iframe',
	'input',
	'link',
	'meta',
	'nav',
	'noscript',
	'object',
	'script',
	'select',
	'style',
	'svg',
	'textarea',
	'video',
]);

const VOID_TAGS = new Set(['br', 'hr', 'img']);

const STYLES = `
body {
  font-family: serif;
  line-height: 1.55;
  margin: 5%;
  orphans: 2;
  widows: 2;
}
.article-header {
  border-bottom: 1px solid #999;
  margin-bottom: 1.5em;
  padding-bottom: 1em;
}
h1 { font-size: 2em; line-height: 1.15; margin: 0 0 0.5em; }
h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.5em 0 0.5em; }
p, li { hyphens: auto; }
.metadata, .source { color: #555; font-size: 0.85em; }
.source { border-top: 1px solid #999; margin-top: 2em; padding-top: 1em; }
img { display: block; height: auto; margin: 1.25em auto; max-width: 100%; page-break-inside: avoid; }
figure, table, pre, blockquote { page-break-inside: avoid; }
figcaption { color: #555; font-size: 0.85em; text-align: center; }
blockquote { border-left: 0.2em solid #999; margin-left: 0; padding-left: 1em; }
pre { overflow-wrap: anywhere; white-space: pre-wrap; }
code, kbd, pre, samp { font-family: monospace; }
table { border-collapse: collapse; max-width: 100%; }
td, th { border: 1px solid #999; padding: 0.35em; }
a { color: inherit; text-decoration: underline; }
`.trim();

interface EpubOptions {
	fetcher?: typeof fetch;
	now?: Date;
}

interface EmbeddedImage {
	data: Uint8Array;
	extension: 'gif' | 'jpg' | 'png' | 'webp';
	mediaType: 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp';
	path: string;
}

interface EmbeddedImages {
	assets: EmbeddedImage[];
	byElement: WeakMap<SerializableNode, EmbeddedImage>;
}

interface SerializableNode {
	childNodes: ArrayLike<SerializableNode>;
	localName?: string;
	nodeType: number;
	nodeValue?: string | null;
	parentElement?: SerializableNode | null;
	closest?(selector: string): SerializableNode | null;
	getAttribute?(name: string): string | null;
	remove?(): void;
	querySelectorAll?(selector: string): ArrayLike<SerializableNode>;
}

interface SerializationContext {
	images: EmbeddedImages;
	sourceUrl: string;
	usedIds: Set<string>;
}

export async function createEpub(html: string, sourceUrl: string, options: EpubOptions = {}): Promise<Uint8Array> {
	if (html.length > MAX_HTML_CHARS) throw new Error('The rendered page is too large to convert to EPUB');

	const source = new URL(sourceUrl);
	const document = new DOMParser().parseFromString(html, 'text/html');
	const articleRoot = document.querySelector('article, main, [role="main"]');
	const fallbackRoot = articleRoot ?? document.body;
	const fallbackContent = fallbackRoot?.outerHTML ?? '';
	const fallbackTitle = document.title.trim() || source.hostname;
	const documentLanguage = document.documentElement.getAttribute('lang');

	const base = document.createElement('base', undefined);
	base.setAttribute('href', source.href);
	document.head.append(base);

	// Readability rewrites the document in place, and it drops the lead image because that sits outside
	// the article body it selects, so the candidate has to be captured first.
	const leadImage = findLeadImage(articleRoot, source.href);

	const readable = new Readability(document, { charThreshold: 100, maxElemsToParse: MAX_DOM_ELEMENTS }).parse();
	const content = readable?.content?.trim() || fallbackContent;
	if (!content) throw new Error('No readable content was found on this page');
	if (content.length > MAX_ARTICLE_CHARS) throw new Error('The extracted article is too large to convert to EPUB');

	const title = readable?.title?.trim() || fallbackTitle;
	const language = normalizeLanguage(readable?.lang || documentLanguage);
	const direction = readable?.dir === 'rtl' ? 'rtl' : 'ltr';
	const articleDocument = new DOMParser().parseFromString(`<html><body>${content}</body></html>`, 'text/html');
	const articleImages = Array.from(articleDocument.querySelectorAll('img')).filter(isSerializableNode);
	const lead = insertLeadImage(articleDocument, leadImage, source.href, articleImages);
	const imageElements = lead ? [lead.image, ...articleImages] : articleImages;
	const images = await embedImages(imageElements, source.href, options.fetcher ?? fetch);
	// An unfetchable lead image would otherwise leave an empty figure at the top of the article.
	if (lead && !images.byElement.has(lead.image)) lead.figure.remove?.();
	const articleBody = serializeChildren(articleDocument.body, { images, sourceUrl: source.href, usedIds: new Set() });
	if (!articleBody.trim()) throw new Error('No readable content remained after sanitizing this page');

	const now = options.now ?? new Date();
	const modified = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
	const metadata = [readable?.byline, readable?.siteName, readable?.publishedTime].filter(Boolean).map(String);
	const files: Zippable = {};

	// EPUB readers require this to be the first ZIP entry and stored without compression.
	files.mimetype = [strToU8('application/epub+zip'), { level: 0 }];
	files['META-INF/container.xml'] = strToU8(containerXml());
	files['OEBPS/content.opf'] = strToU8(contentOpf({ images, language, modified, sourceUrl: source.href, title, byline: readable?.byline }));
	files['OEBPS/nav.xhtml'] = strToU8(navXhtml(title, language, direction));
	files['OEBPS/article.xhtml'] = strToU8(articleXhtml({ articleBody, direction, language, metadata, sourceUrl: source.href, title }));
	files['OEBPS/styles.css'] = strToU8(STYLES);

	for (const image of images.assets) {
		files[`OEBPS/${image.path}`] = [image.data, { level: 0 }];
	}

	const epub = zipSync(files, { level: 6, mtime: now });
	if (epub.byteLength > MAX_EPUB_BYTES) throw new Error('The generated EPUB is too large to deliver');

	return epub;
}

type ParsedDocument = Extract<ReturnType<DOMParser['parseFromString']>, { body: unknown }>;

interface LeadImage {
	alt: string;
	urls: string[];
}

/**
 * Finds the image a reader expects at the top of the article, such as a post hero, which Readability
 * discards whenever it sits outside the body of copy.
 */
function findLeadImage(root: unknown, sourceUrl: string): LeadImage | null {
	if (!isSerializableNode(root) || !root.querySelectorAll) return null;

	const elements = root.querySelectorAll('img');
	let inspected = 0;

	for (let index = 0; index < Math.min(elements.length, MAX_LEAD_IMAGE_SCAN); index += 1) {
		const candidate = elements[index];
		if (!isSerializableNode(candidate)) continue;
		if (candidate.getAttribute?.('aria-hidden')?.toLowerCase() === 'true') continue;
		const identity = `${candidate.getAttribute?.('class') ?? ''} ${candidate.getAttribute?.('id') ?? ''}`;
		if (NON_CONTENT_IMAGE.test(identity) || isBelowLeadImageSize(candidate)) continue;
		// Readability was right to drop promos and related posts, so they must not return as the lead image.
		if (candidate.closest?.(LEAD_IMAGE_EXCLUDED_REGIONS)) continue;

		// Resolving candidate sources is the expensive step, so it carries the tighter budget.
		inspected += 1;
		if (inspected > MAX_LEAD_IMAGE_CANDIDATES) break;

		// An empty list means every candidate source was a placeholder or an unsupported scheme.
		const urls = getImageUrls(candidate, sourceUrl);
		if (urls.length === 0) continue;

		return { alt: candidate.getAttribute?.('alt')?.trim() ?? '', urls: urls.slice(0, MAX_IMAGE_ATTEMPTS_PER_ELEMENT) };
	}

	return null;
}

/** Treats an image as too small only when every dimension it declares is below the threshold. */
function isBelowLeadImageSize(element: SerializableNode): boolean {
	const dimensions = ['width', 'height']
		.map((name) => element.getAttribute?.(name)?.trim())
		.filter((value): value is string => /^\d+$/.test(value ?? ''))
		.map(Number)
		.filter((value) => value > 0);

	return dimensions.length > 0 && dimensions.every((value) => value < MIN_LEAD_IMAGE_DIMENSION);
}

/**
 * Collapses the resized variants of one asset onto a single key so that a header and a body copy of the
 * same image are recognised as duplicates.
 */
function imageIdentity(url: string): string {
	if (url.slice(0, 5).toLowerCase() === 'data:') return url;

	try {
		const parsed = new URL(url);
		const proxied = parsed.searchParams.get('href') ?? parsed.searchParams.get('url') ?? parsed.searchParams.get('src');
		return proxied ? `${parsed.origin}${parsed.pathname}?${proxied}` : `${parsed.origin}${parsed.pathname}`;
	} catch {
		return url;
	}
}

function insertLeadImage(
	articleDocument: ParsedDocument,
	lead: LeadImage | null,
	sourceUrl: string,
	articleImages: SerializableNode[],
): { figure: SerializableNode; image: SerializableNode } | null {
	const [primary, second, third, fourth] = lead?.urls ?? [];
	if (!primary) return null;

	const wanted = new Set(lead?.urls.map(imageIdentity));
	// Many sites keep the lead image inside the article, where Readability already preserved it.
	for (const element of articleImages) {
		for (const url of getImageUrls(element, sourceUrl)) {
			if (wanted.has(imageIdentity(url))) return null;
		}
	}

	const image = articleDocument.createElement('img', undefined);
	// The attributes are chosen so that getImageUrls replays the candidates in their original order.
	image.setAttribute('data-epub-src', primary);
	if (second) image.setAttribute('data-src', second);
	image.setAttribute('src', third ?? primary);
	if (fourth) image.setAttribute('data-epub-fallback-src', fourth);
	image.setAttribute('alt', lead?.alt ?? '');

	const figure = articleDocument.createElement('figure', undefined);
	figure.append(image);
	articleDocument.body.prepend(figure);

	return isSerializableNode(figure) && isSerializableNode(image) ? { figure, image } : null;
}

async function embedImages(elements: SerializableNode[], sourceUrl: string, fetcher: typeof fetch): Promise<EmbeddedImages> {
	const images: EmbeddedImages = { assets: [], byElement: new WeakMap() };
	const imagesByUrl = new Map<string, EmbeddedImage>();
	const rejectedUrls = new Set<string>();
	let attempts = 0;
	let totalBytes = 0;

	for (const element of elements) {
		let elementAttempts = 0;
		for (const url of getImageUrls(element, sourceUrl)) {
			const existingImage = imagesByUrl.get(url);
			if (existingImage) {
				images.byElement.set(element, existingImage);
				break;
			}
			if (
				rejectedUrls.has(url) ||
				attempts >= MAX_IMAGE_ATTEMPTS ||
				elementAttempts >= MAX_IMAGE_ATTEMPTS_PER_ELEMENT ||
				images.assets.length >= MAX_IMAGES
			)
				continue;

			const remainingBytes = MAX_TOTAL_IMAGE_BYTES - totalBytes;
			if (remainingBytes <= 0) continue;
			attempts += 1;
			elementAttempts += 1;

			try {
				const limit = Math.min(MAX_EMBEDDED_IMAGE_BYTES, remainingBytes);
				let data: Uint8Array | null;

				if (url.slice(0, 5).toLowerCase() === 'data:') {
					data = decodeDataImage(url, limit);
				} else {
					const response = await fetcher(url, {
						headers: { Accept: 'image/png,image/jpeg,image/webp,image/gif;q=0.8,*/*;q=0.1' },
						redirect: 'follow',
						signal: AbortSignal.timeout(10_000),
					});
					if (!response.ok) {
						rejectedUrls.add(url);
						continue;
					}

					const contentLength = Number(response.headers.get('content-length'));
					if (Number.isFinite(contentLength) && contentLength > limit) {
						rejectedUrls.add(url);
						continue;
					}
					data = await readBodyWithLimit(response.body, limit);
				}

				if (!data) {
					rejectedUrls.add(url);
					continue;
				}

				const type = detectImageType(data);
				if (!type) {
					rejectedUrls.add(url);
					continue;
				}

				const imageNumber = images.assets.length + 1;
				const image: EmbeddedImage = {
					data,
					extension: type.extension,
					mediaType: type.mediaType,
					path: `images/image-${imageNumber}.${type.extension}`,
				};
				images.assets.push(image);
				images.byElement.set(element, image);
				imagesByUrl.set(url, image);
				totalBytes += data.byteLength;
				break;
			} catch {
				rejectedUrls.add(url);
				// A blocked or unsupported image should not prevent delivery of the article text.
			}
		}
	}

	return images;
}

function decodeDataImage(url: string, limit: number): Uint8Array | null {
	const comma = url.indexOf(',');
	if (comma < 0 || comma > 128) return null;

	const metadata = url.slice(5, comma).split(';');
	const mediaType = metadata.shift()?.toLowerCase();
	if (!mediaType || !DATA_IMAGE_MEDIA_TYPES.has(mediaType) || !metadata.some((value) => value.toLowerCase() === 'base64')) return null;

	const payload = url.slice(comma + 1);
	if (payload.length > Math.min(MAX_DATA_IMAGE_PAYLOAD_CHARS, Math.ceil((limit * 4) / 3) + 4)) return null;

	const encoded = payload.replace(/\s/g, '');
	if (encoded.length % 4 === 1 || !/^[a-z0-9+/]*={0,2}$/i.test(encoded)) return null;

	try {
		const binary = atob(encoded);
		if (binary.length > limit) return null;

		const data = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index += 1) data[index] = binary.charCodeAt(index);
		return data;
	} catch {
		return null;
	}
}

function isSerializableNode(value: unknown): value is SerializableNode {
	return typeof value === 'object' && value !== null && 'nodeType' in value && 'childNodes' in value;
}

async function readBodyWithLimit(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array | null> {
	if (!body) return null;

	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		totalBytes += value.byteLength;
		if (totalBytes > limit) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}

	const result = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}

	return result;
}

function detectImageType(data: Uint8Array): Pick<EmbeddedImage, 'extension' | 'mediaType'> | null {
	if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
		return { extension: 'png', mediaType: 'image/png' };
	}
	if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
		return { extension: 'jpg', mediaType: 'image/jpeg' };
	}
	if (data.length >= 6 && String.fromCharCode(...data.subarray(0, 6)).match(/^GIF8[79]a$/)) {
		return { extension: 'gif', mediaType: 'image/gif' };
	}
	if (
		data.length >= 12 &&
		String.fromCharCode(...data.subarray(0, 4)) === 'RIFF' &&
		String.fromCharCode(...data.subarray(8, 12)) === 'WEBP'
	) {
		return { extension: 'webp', mediaType: 'image/webp' };
	}

	return null;
}

function serializeChildren(node: SerializableNode, context: SerializationContext): string {
	return Array.from(node.childNodes, (child) => serializeNode(child, context)).join('');
}

function serializeNode(node: SerializableNode, context: SerializationContext): string {
	if (node.nodeType === 3) return escapeXml(node.nodeValue ?? '');
	if (node.nodeType !== 1 || !node.localName || !node.getAttribute) return '';

	const tag = node.localName.toLowerCase();
	if (BLOCKED_TAGS.has(tag)) return '';
	if (!ALLOWED_TAGS.has(tag)) return serializeChildren(node, context);

	if (tag === 'img' && !context.images.byElement.has(node)) return '';

	const attributes = serializeAttributes(node, tag, context);
	if (VOID_TAGS.has(tag)) return `<${tag}${attributes} />`;

	return `<${tag}${attributes}>${serializeChildren(node, context)}</${tag}>`;
}

function serializeAttributes(element: SerializableNode, tag: string, context: SerializationContext): string {
	const get = (name: string) => element.getAttribute?.(name)?.trim() || null;
	const attributes: Array<[string, string]> = [];
	const id = get('id');
	const title = get('title');
	const direction = get('dir');
	const language = get('lang');

	if (id && !/\s/.test(id) && !context.usedIds.has(id)) {
		attributes.push(['id', id]);
		context.usedIds.add(id);
	}
	if (title) attributes.push(['title', title]);
	if (direction && ['ltr', 'rtl', 'auto'].includes(direction)) attributes.push(['dir', direction]);
	if (language) attributes.push(['lang', normalizeLanguage(language)]);

	if (tag === 'a') {
		const href = getSafeLink(get('href'), context.sourceUrl);
		if (href) attributes.push(['href', href]);
	}
	if (tag === 'img') {
		const image = context.images.byElement.get(element);
		if (image) attributes.push(['src', image.path]);
		const alt = get('alt');
		attributes.push(['alt', alt ?? '']);
	}
	if (tag === 'blockquote' || tag === 'q') {
		const cite = getSafeLink(get('cite'), context.sourceUrl);
		if (cite) attributes.push(['cite', cite]);
	}
	if (tag === 'time') {
		const dateTime = get('datetime');
		if (dateTime) attributes.push(['datetime', dateTime]);
	}
	if (tag === 'td' || tag === 'th') {
		for (const name of ['colspan', 'rowspan']) {
			const value = get(name);
			if (value && /^\d{1,3}$/.test(value)) attributes.push([name, value]);
		}
	}
	if (tag === 'ol') {
		const start = get('start');
		if (start && /^-?\d+$/.test(start)) attributes.push(['start', start]);
	}

	return attributes.map(([name, value]) => ` ${name}="${escapeXml(value)}"`).join('');
}

function getImageUrls(element: SerializableNode, sourceUrl: string): string[] {
	const candidates: string[] = [];
	const fallbackCandidates: string[] = [];
	const picture = element.parentElement?.localName?.toLowerCase() === 'picture' ? element.parentElement : null;
	const renderedSource = element.getAttribute?.('data-epub-src')?.trim();
	if (renderedSource) candidates.push(renderedSource);
	const lazyCandidates = ['data-src', 'data-original', 'data-lazy-src']
		.map((name) => element.getAttribute?.(name)?.trim())
		.filter((candidate): candidate is string => Boolean(candidate));
	if (lazyCandidates[0]) candidates.push(lazyCandidates[0]);

	const responsiveCandidates: string[] = [];

	if (picture?.querySelectorAll) {
		for (const source of Array.from(picture.querySelectorAll('source'))) {
			const type = source.getAttribute?.('type')?.trim().toLowerCase();
			const media = source.getAttribute?.('media')?.trim().toLowerCase();
			if ((media && media !== 'all') || (type && !DATA_IMAGE_MEDIA_TYPES.has(type))) continue;

			responsiveCandidates.push(...orderSrcsetCandidates(source.getAttribute?.('srcset') || source.getAttribute?.('data-srcset')));
		}
	}

	responsiveCandidates.push(...orderSrcsetCandidates(element.getAttribute?.('srcset') || element.getAttribute?.('data-srcset')));
	if (responsiveCandidates[0]) candidates.push(responsiveCandidates[0]);

	const src = element.getAttribute?.('src')?.trim();
	if (src) candidates.push(src);
	const browserFallback = element.getAttribute?.('data-epub-fallback-src')?.trim();
	if (browserFallback) candidates.push(browserFallback);
	fallbackCandidates.push(...lazyCandidates.slice(1), ...responsiveCandidates.slice(1));
	candidates.push(...fallbackCandidates);

	const urls: string[] = [];
	const seen = new Set<string>();
	for (const candidate of candidates) {
		let normalized: string | null = null;
		if (hasSupportedDataImageHeader(candidate)) normalized = candidate;

		if (!normalized) {
			try {
				const url = new URL(candidate, sourceUrl);
				if (url.protocol === 'http:' || url.protocol === 'https:') normalized = url.href;
			} catch {
				continue;
			}
		}

		if (normalized && !seen.has(normalized)) {
			seen.add(normalized);
			urls.push(normalized);
		}
	}

	return urls;
}

function hasSupportedDataImageHeader(value: string): boolean {
	if (value.slice(0, 11).toLowerCase() !== 'data:image/') return false;

	const comma = value.indexOf(',');
	if (comma < 0 || comma > 128) return false;

	const metadata = value.slice(5, comma).split(';');
	const mediaType = metadata.shift()?.toLowerCase();
	return Boolean(mediaType && DATA_IMAGE_MEDIA_TYPES.has(mediaType) && metadata.some((part) => part.toLowerCase() === 'base64'));
}

function orderSrcsetCandidates(value: string | null | undefined): string[] {
	if (!value) return [];

	const candidates: Array<{ density?: number; url: string; width?: number }> = [];
	let position = 0;

	while (position < value.length) {
		while (position < value.length && /[\s,]/.test(value[position])) position += 1;
		const urlStart = position;
		while (position < value.length && !/\s/.test(value[position])) position += 1;

		let url = value.slice(urlStart, position);
		if (!url) break;

		let descriptor = '';
		if (url.endsWith(',')) {
			url = url.replace(/,+$/, '');
		} else {
			while (position < value.length && /\s/.test(value[position])) position += 1;
			const descriptorStart = position;
			while (position < value.length && value[position] !== ',') position += 1;
			descriptor = value.slice(descriptorStart, position).trim();
		}
		if (value[position] === ',') position += 1;

		if (!url || descriptor.split(/\s+/).filter(Boolean).length > 1) continue;
		const widthMatch = descriptor.match(/^(\d+)w$/);
		const densityMatch = descriptor.match(/^(\d*\.?\d+)x$/);
		if (descriptor && !widthMatch && !densityMatch) continue;

		const width = widthMatch ? Number(widthMatch[1]) : undefined;
		const density = densityMatch ? Number(densityMatch[1]) : undefined;
		if (width !== undefined && width <= 0) continue;
		if (density !== undefined && density <= 0) continue;
		candidates.push({ url, width, density });
	}

	const widths = candidates.filter((candidate): candidate is typeof candidate & { width: number } => candidate.width !== undefined);
	if (widths.length) {
		const suitable = widths.filter((candidate) => candidate.width <= MAX_RESPONSIVE_IMAGE_WIDTH);
		const oversized = widths.filter((candidate) => candidate.width > MAX_RESPONSIVE_IMAGE_WIDTH);
		const remaining = candidates.filter((candidate) => candidate.width === undefined);
		return [
			...suitable.sort((left, right) => right.width - left.width),
			...oversized.sort((left, right) => left.width - right.width),
			...remaining,
		].map((candidate) => candidate.url);
	}

	const densities = candidates.map((candidate) => ({ ...candidate, density: candidate.density ?? 1 }));
	const suitable = densities.filter((candidate) => candidate.density <= 2);
	const oversized = densities.filter((candidate) => candidate.density > 2);
	return [
		...suitable.sort((left, right) => right.density - left.density),
		...oversized.sort((left, right) => left.density - right.density),
	].map((candidate) => candidate.url);
}

function getSafeLink(value: string | null, sourceUrl: string): string | null {
	if (!value) return null;
	if (value.startsWith('#')) return value;

	try {
		const url = new URL(value, sourceUrl);
		if (['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol)) return url.href;
	} catch {
		return null;
	}

	return null;
}

function normalizeLanguage(value: string | null | undefined): string {
	const normalized = value?.trim().replaceAll('_', '-');
	return normalized && /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(normalized) ? normalized : 'en';
}

function escapeXml(value: string): string {
	return value
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&apos;');
}

function containerXml(): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml" />
  </rootfiles>
</container>`;
}

function contentOpf({
	images,
	language,
	modified,
	sourceUrl,
	title,
	byline,
}: {
	images: EmbeddedImages;
	language: string;
	modified: string;
	sourceUrl: string;
	title: string;
	byline?: string | null;
}): string {
	const imageManifest = images.assets
		.map((image, index) => `    <item id="image-${index + 1}" href="${escapeXml(image.path)}" media-type="${image.mediaType}" />`)
		.join('\n');
	const creator = byline ? `\n    <dc:creator>${escapeXml(byline)}</dc:creator>` : '';

	return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="${escapeXml(language)}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">${escapeXml(sourceUrl)}</dc:identifier>
    <dc:title>${escapeXml(title)}</dc:title>
    <dc:language>${escapeXml(language)}</dc:language>${creator}
    <dc:source>${escapeXml(sourceUrl)}</dc:source>
    <meta property="dcterms:modified">${escapeXml(modified)}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />
    <item id="article" href="article.xhtml" media-type="application/xhtml+xml" />
    <item id="styles" href="styles.css" media-type="text/css" />
${imageManifest ? `${imageManifest}\n` : ''}  </manifest>
  <spine>
    <itemref idref="article" />
  </spine>
</package>`;
}

function navXhtml(title: string, language: string, direction: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${escapeXml(language)}" xml:lang="${escapeXml(language)}" dir="${direction}">
  <head><title>Contents</title></head>
  <body>
    <nav epub:type="toc" id="toc">
      <h1>Contents</h1>
      <ol><li><a href="article.xhtml">${escapeXml(title)}</a></li></ol>
    </nav>
  </body>
</html>`;
}

function articleXhtml({
	articleBody,
	direction,
	language,
	metadata,
	sourceUrl,
	title,
}: {
	articleBody: string;
	direction: string;
	language: string;
	metadata: string[];
	sourceUrl: string;
	title: string;
}): string {
	const metadataHtml = metadata.length ? `<p class="metadata">${metadata.map(escapeXml).join(' | ')}</p>` : '';

	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="${escapeXml(language)}" xml:lang="${escapeXml(language)}" dir="${direction}">
  <head>
    <title>${escapeXml(title)}</title>
    <link rel="stylesheet" type="text/css" href="styles.css" />
  </head>
  <body>
    <header class="article-header">
      <h1>${escapeXml(title)}</h1>
      ${metadataHtml}
    </header>
    <main>${articleBody}</main>
    <footer class="source">Source: <a href="${escapeXml(sourceUrl)}">${escapeXml(sourceUrl)}</a></footer>
  </body>
</html>`;
}
