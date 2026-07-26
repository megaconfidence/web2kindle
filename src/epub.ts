import { Readability } from '@mozilla/readability';
import { strToU8, zipSync, type Zippable } from 'fflate';
import { DOMParser } from 'linkedom/worker';

const MAX_IMAGES = 12;
const MAX_IMAGE_ATTEMPTS = 36;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_ARTICLE_CHARS = 3 * 1024 * 1024;
const MAX_DOM_ELEMENTS = 100_000;
export const MAX_HTML_CHARS = 6 * 1024 * 1024;
export const MAX_EPUB_BYTES = 20 * 1024 * 1024;

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
	extension: 'gif' | 'jpg' | 'png';
	mediaType: 'image/gif' | 'image/jpeg' | 'image/png';
	path: string;
}

interface SerializableNode {
	childNodes: ArrayLike<SerializableNode>;
	localName?: string;
	nodeType: number;
	nodeValue?: string | null;
	getAttribute?(name: string): string | null;
}

interface SerializationContext {
	images: Map<string, EmbeddedImage>;
	sourceUrl: string;
	usedIds: Set<string>;
}

export async function createEpub(html: string, sourceUrl: string, options: EpubOptions = {}): Promise<Uint8Array> {
	if (html.length > MAX_HTML_CHARS) throw new Error('The rendered page is too large to convert to EPUB');

	const source = new URL(sourceUrl);
	const document = new DOMParser().parseFromString(html, 'text/html');
	const fallbackRoot = document.querySelector('article, main, [role="main"]') ?? document.body;
	const fallbackContent = fallbackRoot?.outerHTML ?? '';
	const fallbackTitle = document.title.trim() || source.hostname;
	const documentLanguage = document.documentElement.getAttribute('lang');

	const base = document.createElement('base', undefined);
	base.setAttribute('href', source.href);
	document.head.append(base);

	const readable = new Readability(document, { charThreshold: 100, maxElemsToParse: MAX_DOM_ELEMENTS }).parse();
	const content = readable?.content?.trim() || fallbackContent;
	if (!content) throw new Error('No readable content was found on this page');
	if (content.length > MAX_ARTICLE_CHARS) throw new Error('The extracted article is too large to convert to EPUB');

	const title = readable?.title?.trim() || fallbackTitle;
	const language = normalizeLanguage(readable?.lang || documentLanguage);
	const direction = readable?.dir === 'rtl' ? 'rtl' : 'ltr';
	const articleDocument = new DOMParser().parseFromString(`<html><body>${content}</body></html>`, 'text/html');
	const imageElements = Array.from(articleDocument.querySelectorAll('img')).filter(isSerializableNode);
	const images = await embedImages(imageElements, source.href, options.fetcher ?? fetch);
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

	for (const image of images.values()) {
		files[`OEBPS/${image.path}`] = [image.data, { level: 0 }];
	}

	const epub = zipSync(files, { level: 6, mtime: now });
	if (epub.byteLength > MAX_EPUB_BYTES) throw new Error('The generated EPUB is too large to deliver');

	return epub;
}

async function embedImages(elements: SerializableNode[], sourceUrl: string, fetcher: typeof fetch): Promise<Map<string, EmbeddedImage>> {
	const urls = elements.map((image) => getImageUrl(image, sourceUrl)).filter((url): url is string => url !== null);
	const uniqueUrls = [...new Set(urls)].slice(0, MAX_IMAGE_ATTEMPTS);
	const images = new Map<string, EmbeddedImage>();
	let totalBytes = 0;

	for (const url of uniqueUrls) {
		const remainingBytes = MAX_TOTAL_IMAGE_BYTES - totalBytes;
		if (remainingBytes <= 0 || images.size >= MAX_IMAGES) break;

		try {
			const response = await fetcher(url, {
				headers: { Accept: 'image/png,image/jpeg,image/gif' },
				redirect: 'follow',
				signal: AbortSignal.timeout(10_000),
			});
			if (!response.ok) continue;

			const limit = Math.min(MAX_IMAGE_BYTES, remainingBytes);
			const contentLength = Number(response.headers.get('content-length'));
			if (Number.isFinite(contentLength) && contentLength > limit) continue;

			const data = await readBodyWithLimit(response.body, limit);
			if (!data) continue;

			const type = detectImageType(data);
			if (!type) continue;

			const imageNumber = images.size + 1;
			const image: EmbeddedImage = {
				data,
				extension: type.extension,
				mediaType: type.mediaType,
				path: `images/image-${imageNumber}.${type.extension}`,
			};
			images.set(url, image);
			totalBytes += data.byteLength;
		} catch {
			// A blocked or unsupported image should not prevent delivery of the article text.
		}
	}

	return images;
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

	if (tag === 'img') {
		const imageUrl = getImageUrl(node, context.sourceUrl);
		const image = imageUrl ? context.images.get(imageUrl) : undefined;
		if (!image) return '';
	}

	const attributes = serializeAttributes(node, tag, context);
	if (VOID_TAGS.has(tag)) return `<${tag}${attributes} />`;

	return `<${tag}${attributes}>${serializeChildren(node, context)}</${tag}>`;
}

function serializeAttributes(element: Pick<SerializableNode, 'getAttribute'>, tag: string, context: SerializationContext): string {
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
		const imageUrl = getImageUrl(element, context.sourceUrl);
		const image = imageUrl ? context.images.get(imageUrl) : undefined;
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

function getImageUrl(element: Pick<SerializableNode, 'getAttribute'>, sourceUrl: string): string | null {
	const candidates = ['src', 'data-src', 'data-original', 'data-lazy-src']
		.map((name) => element.getAttribute?.(name)?.trim())
		.filter((value): value is string => Boolean(value));

	const srcset = element.getAttribute?.('srcset') || element.getAttribute?.('data-srcset');
	if (srcset && !srcset.startsWith('data:')) {
		const srcsetCandidates = srcset.split(',');
		const lastCandidate = srcsetCandidates[srcsetCandidates.length - 1]?.trim().split(/\s+/)[0];
		if (lastCandidate) candidates.push(lastCandidate);
	}

	for (const candidate of candidates) {
		try {
			const url = new URL(candidate, sourceUrl);
			if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
		} catch {
			continue;
		}
	}

	return null;
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
	images: Map<string, EmbeddedImage>;
	language: string;
	modified: string;
	sourceUrl: string;
	title: string;
	byline?: string | null;
}): string {
	const imageManifest = Array.from(
		images.values(),
		(image, index) => `    <item id="image-${index + 1}" href="${escapeXml(image.path)}" media-type="${image.mediaType}" />`,
	).join('\n');
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
