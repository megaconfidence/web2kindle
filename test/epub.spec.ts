import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { createEpub, MAX_HTML_CHARS } from '../src/epub';

const HTML = `<!doctype html>
<html lang="en">
  <head>
    <title>A useful article</title>
    <meta name="author" content="Ada Reader" />
  </head>
  <body>
    <nav>Site navigation that should be removed</nav>
    <article>
      <h1>A useful article</h1>
      <p>${'This is substantial article copy written for a clean reading view. '.repeat(12)}</p>
      <figure><img src="/images/hero.png" alt="Article illustration" /><figcaption>A useful illustration</figcaption></figure>
      <p><a href="/related">Read the related article</a></p>
      <script>alert('not allowed')</script>
    </article>
  </body>
</html>`;

const LEAD_IMAGE_HTML = `<!doctype html>
<html lang="en">
  <head><title>A useful article</title></head>
  <body>
    <main>
      <header class="post-header">
        <h1>A useful article</h1>
        <img src="/hero.png" alt="Hero illustration" width="1200" height="600" />
      </header>
      <div class="post-content">
        <p>${'This is substantial article copy written for a clean reading view. '.repeat(12)}</p>
        <p>${'A second paragraph keeps the extracted article comfortably above the density threshold. '.repeat(12)}</p>
        <p>Closing thoughts on the topic.</p>
      </div>
    </main>
  </body>
</html>`;

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP_SIGNATURE = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x04, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

describe('EPUB generation', () => {
	it('builds a valid reflowable EPUB package with embedded images', async () => {
		const fetcher: typeof fetch = async () =>
			new Response(PNG_SIGNATURE, {
				headers: { 'content-length': String(PNG_SIGNATURE.byteLength), 'content-type': 'image/png' },
			});
		const epub = await createEpub(HTML, 'https://example.com/posts/useful', {
			fetcher,
			now: new Date('2026-07-26T12:00:00Z'),
		});

		expect(firstZipEntry(epub)).toEqual({ compressionMethod: 0, name: 'mimetype' });

		const files = unzipSync(epub);
		expect(strFromU8(files.mimetype)).toBe('application/epub+zip');
		expect(Object.keys(files)).toEqual(
			expect.arrayContaining([
				'META-INF/container.xml',
				'OEBPS/content.opf',
				'OEBPS/nav.xhtml',
				'OEBPS/article.xhtml',
				'OEBPS/styles.css',
				'OEBPS/images/image-1.png',
			]),
		);

		const article = strFromU8(files['OEBPS/article.xhtml']);
		const manifest = strFromU8(files['OEBPS/content.opf']);
		expect(article).toContain('A useful article');
		expect(article).toContain('src="images/image-1.png"');
		expect(article).toContain('href="https://example.com/related"');
		expect(article).not.toContain('<script');
		expect(article).not.toContain('Site navigation');
		expect(manifest).toContain('media-type="image/png"');
		expect(manifest).toContain('<meta property="dcterms:modified">2026-07-26T12:00:00Z</meta>');
	});

	it('falls back to the main page content when Readability cannot identify an article', async () => {
		const epub = await createEpub(
			'<html><head><title>Short note</title></head><body><main><p>A brief but useful note.</p></main></body></html>',
			'https://example.com/note',
			{ now: new Date('2026-07-26T12:00:00Z') },
		);
		const article = strFromU8(unzipSync(epub)['OEBPS/article.xhtml']);

		expect(article).toContain('Short note');
		expect(article).toContain('A brief but useful note.');
	});

	it('continues past failed image downloads and removes duplicate IDs', async () => {
		const images = Array.from({ length: 13 }, (_, index) => `<img src="/image-${index + 1}.png" alt="Image ${index + 1}" />`).join('');
		let attempts = 0;
		const fetcher: typeof fetch = async () => {
			attempts += 1;
			return attempts < 13 ? new Response(null, { status: 404 }) : new Response(PNG_SIGNATURE);
		};
		const epub = await createEpub(
			`<html><head><title>Images</title></head><body><main><p id="duplicate">First</p><p id="duplicate">Second</p>${images}</main></body></html>`,
			'https://example.com/post',
			{ fetcher, now: new Date('2026-07-26T12:00:00Z') },
		);
		const files = unzipSync(epub);
		const article = strFromU8(files['OEBPS/article.xhtml']);

		expect(files['OEBPS/images/image-1.png']).toBeDefined();
		expect(article.match(/id="duplicate"/g)).toHaveLength(1);
	});

	it('embeds the data images and responsive WebP used by the Cloudflare BGP article', async () => {
		const jpeg = (suffix: number) => dataImageUrl('image/jpeg', new Uint8Array([0xff, 0xd8, 0xff, suffix]));
		const html = `<!doctype html>
<html><head><title>BGP ORIGIN attribute manipulation</title></head><body><article>
  <h1>BGP ORIGIN attribute manipulation</h1>
  <p>${'This article investigates how transit providers alter a routing attribute across the Internet. '.repeat(12)}</p>
  <img src="data:image/svg+xml,%3Csvg%3E%3C/svg%3E" alt="" />
  <img src="${jpeg(1)}" alt="Experiment topology" />
  <img src="${jpeg(2)}" alt="Observed paths" />
  <img src="${jpeg(3)}" alt="Origin changes" />
  <img src="${dataImageUrl('image/png', PNG_SIGNATURE)}" alt="Results chart" />
  <img src="/hero.webp?w=640&amp;f=webp" srcset="/hero.webp?w=640&amp;f=webp 640w, /hero.webp?w=1080&amp;f=webp 1080w, /hero.webp?w=2400&amp;f=webp 2400w" alt="Article hero" />
</article></body></html>`;
		const fetchedUrls: string[] = [];
		const fetcher: typeof fetch = async (input) => {
			fetchedUrls.push(String(input));
			return new Response(WEBP_SIGNATURE, { headers: { 'content-type': 'image/webp' } });
		};

		const epub = await createEpub(html, 'https://blog.cloudflare.com/bgp-origin-attribute/', {
			fetcher,
			now: new Date('2026-07-26T12:00:00Z'),
		});
		const files = unzipSync(epub);
		const article = strFromU8(files['OEBPS/article.xhtml']);
		const manifest = strFromU8(files['OEBPS/content.opf']);

		expect(fetchedUrls).toEqual(['https://blog.cloudflare.com/hero.webp?w=1080&f=webp']);
		expect(Object.keys(files).filter((path) => path.startsWith('OEBPS/images/'))).toEqual([
			'OEBPS/images/image-1.jpg',
			'OEBPS/images/image-2.jpg',
			'OEBPS/images/image-3.jpg',
			'OEBPS/images/image-4.png',
			'OEBPS/images/image-5.webp',
		]);
		expect(article.match(/<img /g)).toHaveLength(5);
		expect(article).not.toContain('data:image');
		expect(manifest).toContain('media-type="image/webp"');
	});

	it('falls back when preferred embedded images are malformed or oversized', async () => {
		const oversizedPayload = 'A'.repeat(Math.ceil(((2 * 1024 * 1024 + 1) * 4) / 3) + 8);
		const html = `<html><head><title>Image fallbacks</title></head><body><article>
      <h1>Image fallbacks</h1>
      <p>${'Substantial article text for testing safe image candidate fallback. '.repeat(12)}</p>
      <img data-src="data:image/png;base64,not-valid!" src="/valid-1.png" alt="First fallback" />
      <img data-src="data:image/png;base64,${oversizedPayload}" src="/valid-2.png" alt="Second fallback" />
    </article></body></html>`;
		const fetchedUrls: string[] = [];
		const fetcher: typeof fetch = async (input) => {
			fetchedUrls.push(String(input));
			return new Response(PNG_SIGNATURE);
		};

		const epub = await createEpub(html, 'https://example.com/article', {
			fetcher,
			now: new Date('2026-07-26T12:00:00Z'),
		});
		const files = unzipSync(epub);

		expect(fetchedUrls).toEqual(['https://example.com/valid-1.png', 'https://example.com/valid-2.png']);
		expect(Object.keys(files).filter((path) => path.startsWith('OEBPS/images/'))).toHaveLength(2);
	});

	it('retains a remote fallback when a data image exceeds the remaining aggregate budget', async () => {
		const largePng = new Uint8Array(1_950_000);
		largePng.set(PNG_SIGNATURE);
		const selectedPng = new Uint8Array(800_000);
		selectedPng.set(PNG_SIGNATURE);
		const leadingImages = Array.from({ length: 5 }, (_, index) => `<img src="/large-${index + 1}.png" alt="Large image" />`).join('');
		const fetchedUrls: string[] = [];
		const fetcher: typeof fetch = async (input) => {
			const url = String(input);
			fetchedUrls.push(url);
			return new Response(url.endsWith('/fallback.png') ? PNG_SIGNATURE : largePng);
		};

		const epub = await createEpub(
			`<html><head><title>Aggregate fallback</title></head><body><article>
        <h1>Aggregate fallback</h1>
        <p>${'Substantial article text for testing the aggregate image budget. '.repeat(12)}</p>
        ${leadingImages}
        <img src="${dataImageUrl('image/png', selectedPng)}" data-epub-fallback-src="/fallback.png" alt="Selected image" />
      </article></body></html>`,
			'https://example.com/article',
			{ fetcher, now: new Date('2026-07-26T12:00:00Z') },
		);

		expect(fetchedUrls).toHaveLength(6);
		expect(fetchedUrls[5]).toBe('https://example.com/fallback.png');
		expect(epub.byteLength).toBeGreaterThan(9_750_000);
	});

	it('uses rendered picture sources and treats omitted srcset descriptors as 1x', async () => {
		const html = `<html><head><title>Responsive images</title></head><body><article>
      <h1>Responsive images</h1>
      <p>${'Substantial article text for testing responsive image selection. '.repeat(12)}</p>
      <picture>
        <source media="(min-width: 1000px)" srcset="/desktop.png" />
        <img data-epub-src="/desktop.png" src="/mobile.png" alt="Rendered picture" />
      </picture>
      <img src="/fallback.png" srcset="/standard.png, /oversized.png 3x" alt="Density candidates" />
    </article></body></html>`;
		const fetchedUrls: string[] = [];
		const fetcher: typeof fetch = async (input) => {
			fetchedUrls.push(String(input));
			return new Response(PNG_SIGNATURE);
		};

		await createEpub(html, 'https://example.com/article', {
			fetcher,
			now: new Date('2026-07-26T12:00:00Z'),
		});

		expect(fetchedUrls).toEqual(['https://example.com/desktop.png', 'https://example.com/standard.png']);
	});

	it('reaches src fallback without exhausting the global attempt budget', async () => {
		const srcset = Array.from({ length: 36 }, (_, index) => `/missing-${index + 1}.png ${index + 1}w`).join(', ');
		const fetchedUrls: string[] = [];
		const fetcher: typeof fetch = async (input) => {
			const url = String(input);
			fetchedUrls.push(url);
			return url.endsWith('/valid.png') ? new Response(PNG_SIGNATURE) : new Response(null, { status: 404 });
		};
		const epub = await createEpub(
			`<html><head><title>Fallback budget</title></head><body><article>
        <h1>Fallback budget</h1>
        <p>${'Substantial article text for testing bounded responsive image fallbacks. '.repeat(12)}</p>
        <img src="/valid.png" srcset="${srcset}" alt="Fallback image" />
      </article></body></html>`,
			'https://example.com/article',
			{ fetcher, now: new Date('2026-07-26T12:00:00Z') },
		);

		expect(fetchedUrls).toHaveLength(2);
		expect(fetchedUrls[1]).toBe('https://example.com/valid.png');
		expect(unzipSync(epub)['OEBPS/images/image-1.png']).toBeDefined();
	});

	it('adds the lead image that Readability drops with the article header', async () => {
		const fetchedUrls: string[] = [];
		const fetcher: typeof fetch = async (input) => {
			fetchedUrls.push(String(input));
			return new Response(PNG_SIGNATURE, { headers: { 'content-type': 'image/png' } });
		};
		const epub = await createEpub(LEAD_IMAGE_HTML, 'https://example.com/posts/lead', {
			fetcher,
			now: new Date('2026-07-26T12:00:00Z'),
		});
		const files = unzipSync(epub);
		const article = strFromU8(files['OEBPS/article.xhtml']);

		expect(fetchedUrls).toEqual(['https://example.com/hero.png']);
		expect(files['OEBPS/images/image-1.png']).toBeDefined();
		expect(article).toContain('alt="Hero illustration"');
		expect(article.indexOf('images/image-1.png')).toBeLessThan(article.indexOf('This is substantial article copy'));
	});

	it('prefers the lead image over avatars, logos, and placeholders', async () => {
		const fetchedUrls: string[] = [];
		const fetcher: typeof fetch = async (input) => {
			fetchedUrls.push(String(input));
			return new Response(PNG_SIGNATURE, { headers: { 'content-type': 'image/png' } });
		};
		// The Cloudflare blog names the real lead image "...-placeholder-media", next to an aria-hidden placeholder.
		const header = `
      <img class="pt-image-placeholder" aria-hidden="true" src="data:image/svg+xml,%3Csvg%3E%3C/svg%3E" alt="" width="1200" height="600" />
      <img class="site-logo" src="/logo.png" alt="Example" width="1200" height="600" />
      <img class="avatar__image" src="/avatar.png" alt="Ada" width="32" height="32" />
      <img class="pt-image-placeholder-media" src="/hero.png" alt="Hero illustration" width="1200" height="600" />`;

		await createEpub(
			LEAD_IMAGE_HTML.replace('<img src="/hero.png" alt="Hero illustration" width="1200" height="600" />', header),
			'https://example.com/posts/lead',
			{ fetcher, now: new Date('2026-07-26T12:00:00Z') },
		);

		expect(fetchedUrls).toEqual(['https://example.com/hero.png']);
	});

	it('does not repeat a lead image that Readability kept in the article', async () => {
		const fetchedUrls: string[] = [];
		const fetcher: typeof fetch = async (input) => {
			fetchedUrls.push(String(input));
			return new Response(PNG_SIGNATURE, { headers: { 'content-type': 'image/png' } });
		};
		const html = LEAD_IMAGE_HTML.replace('<img src="/hero.png" alt="Hero illustration" width="1200" height="600" />', '').replace(
			'<p>Closing thoughts on the topic.</p>',
			'<p><img src="/hero.png" alt="Hero illustration" width="1200" height="600" /></p>',
		);
		const epub = await createEpub(html, 'https://example.com/posts/lead', { fetcher, now: new Date('2026-07-26T12:00:00Z') });
		const article = strFromU8(unzipSync(epub)['OEBPS/article.xhtml']);

		expect(fetchedUrls).toEqual(['https://example.com/hero.png']);
		expect(article.match(/<img /g)).toHaveLength(1);
	});

	it('ignores promo images in regions Readability was right to drop', async () => {
		const fetchedUrls: string[] = [];
		const fetcher: typeof fetch = async (input) => {
			fetchedUrls.push(String(input));
			return new Response(PNG_SIGNATURE, { headers: { 'content-type': 'image/png' } });
		};
		const html = LEAD_IMAGE_HTML.replace(
			'<header class="post-header">',
			`<aside><img src="/promo.png" alt="Promo" width="900" height="300" /></aside>
       <nav><img src="/partner.png" alt="Partner" width="400" height="220" /></nav>
       <header class="post-header">`,
		);

		await createEpub(html, 'https://example.com/posts/lead', { fetcher, now: new Date('2026-07-26T12:00:00Z') });

		expect(fetchedUrls).toEqual(['https://example.com/hero.png']);
	});

	it('keeps a wide, short lead image and still rejects small ones', async () => {
		const fetchedUrls: string[] = [];
		const fetcher: typeof fetch = async (input) => {
			fetchedUrls.push(String(input));
			return new Response(PNG_SIGNATURE, { headers: { 'content-type': 'image/png' } });
		};
		const html = LEAD_IMAGE_HTML.replace(
			'<img src="/hero.png" alt="Hero illustration" width="1200" height="600" />',
			`<img src="/small.png" alt="Small" width="120" height="90" />
       <img class="iconic-banner" src="/banner.png" alt="Banner" width="1600" height="180" />`,
		);

		await createEpub(html, 'https://example.com/posts/lead', { fetcher, now: new Date('2026-07-26T12:00:00Z') });

		expect(fetchedUrls).toEqual(['https://example.com/banner.png']);
	});

	it('treats resized variants of one asset as the same lead image', async () => {
		const fetchedUrls: string[] = [];
		const fetcher: typeof fetch = async (input) => {
			fetchedUrls.push(String(input));
			return new Response(PNG_SIGNATURE, { headers: { 'content-type': 'image/png' } });
		};
		const html = LEAD_IMAGE_HTML.replace(
			'<img src="/hero.png" alt="Hero illustration" width="1200" height="600" />',
			'<img src="/hero.png?w=1200" alt="Hero illustration" width="1200" height="600" />',
		).replace('<p>Closing thoughts on the topic.</p>', '<p><img src="/hero.png?w=1600" alt="Hero illustration" /></p>');
		const epub = await createEpub(html, 'https://example.com/posts/lead', { fetcher, now: new Date('2026-07-26T12:00:00Z') });
		const article = strFromU8(unzipSync(epub)['OEBPS/article.xhtml']);

		expect(fetchedUrls).toEqual(['https://example.com/hero.png?w=1600']);
		expect(article.match(/<img /g)).toHaveLength(1);
	});

	it('leaves no empty figure when the lead image cannot be fetched', async () => {
		const fetcher: typeof fetch = async () => new Response(null, { status: 404 });
		const epub = await createEpub(LEAD_IMAGE_HTML, 'https://example.com/posts/lead', {
			fetcher,
			now: new Date('2026-07-26T12:00:00Z'),
		});
		const article = strFromU8(unzipSync(epub)['OEBPS/article.xhtml']);

		expect(article).not.toContain('<figure>');
		expect(article).toContain('This is substantial article copy');
	});

	it('replays every lead image candidate before giving up', async () => {
		const fetchedUrls: string[] = [];
		const fetcher: typeof fetch = async (input) => {
			fetchedUrls.push(new URL(String(input)).pathname);
			return new Response(null, { status: 404 });
		};
		const html = LEAD_IMAGE_HTML.replace(
			'<img src="/hero.png" alt="Hero illustration" width="1200" height="600" />',
			'<img src="/src.png" data-src="/lazy.png" srcset="/w320.png 320w, /w1080.png 1080w" alt="Hero" width="1200" height="600" />',
		);

		await createEpub(html, 'https://example.com/posts/lead', { fetcher, now: new Date('2026-07-26T12:00:00Z') });

		// The prepended element replays the candidates in the same priority order getImageUrls gives the original.
		expect(fetchedUrls).toEqual(['/lazy.png', '/w1080.png', '/src.png', '/w320.png']);
	});

	it('rejects oversized rendered pages before parsing them', async () => {
		await expect(createEpub('x'.repeat(MAX_HTML_CHARS + 1), 'https://example.com/large')).rejects.toThrow('too large');
	});
});

function dataImageUrl(mediaType: string, data: Uint8Array): string {
	let binary = '';
	for (let offset = 0; offset < data.length; offset += 32_768) {
		binary += String.fromCharCode(...data.subarray(offset, offset + 32_768));
	}
	return `data:${mediaType};base64,${btoa(binary)}`;
}

function firstZipEntry(epub: Uint8Array): { compressionMethod: number; name: string } {
	const view = new DataView(epub.buffer, epub.byteOffset, epub.byteLength);
	const fileNameLength = view.getUint16(26, true);
	const name = new TextDecoder().decode(epub.subarray(30, 30 + fileNameLength));

	return { compressionMethod: view.getUint16(8, true), name };
}
