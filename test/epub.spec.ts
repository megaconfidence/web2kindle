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

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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

	it('rejects oversized rendered pages before parsing them', async () => {
		await expect(createEpub('x'.repeat(MAX_HTML_CHARS + 1), 'https://example.com/large')).rejects.toThrow('too large');
	});
});

function firstZipEntry(epub: Uint8Array): { compressionMethod: number; name: string } {
	const view = new DataView(epub.buffer, epub.byteOffset, epub.byteLength);
	const fileNameLength = view.getUint16(26, true);
	const name = new TextDecoder().decode(epub.subarray(30, 30 + fileNameLength));

	return { compressionMethod: view.getUint16(8, true), name };
}
