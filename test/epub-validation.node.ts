import { EpubCheck } from '@likecoin/epubcheck-ts';
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { createEpub } from '../src/epub';

const ONE_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const ONE_PIXEL_WEBP = 'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA';

describe('EPUB conformance', () => {
	it('passes EPUBCheck without errors or warnings', async () => {
		const epub = await createEpub(
			`<html lang="en"><head><title>Validated article</title></head><body><article>
        <h1>Validated article</h1>
        <p>${'A substantial article intended for standards validation. '.repeat(12)}</p>
        <img src="data:image/png;base64,${ONE_PIXEL_PNG}" alt="One pixel illustration" />
        <img src="data:image/webp;base64,${ONE_PIXEL_WEBP}" alt="One pixel WebP illustration" />
      </article></body></html>`,
			'https://example.com/validated-article',
			{ now: new Date('2026-07-26T12:00:00Z') },
		);
		const result = await EpubCheck.validate(epub);
		const files = unzipSync(epub);
		const article = strFromU8(files['OEBPS/article.xhtml']);
		const manifest = strFromU8(files['OEBPS/content.opf']);

		expect(files['OEBPS/images/image-2.webp']).toBeDefined();
		expect(article).toContain('src="images/image-2.webp"');
		expect(manifest).toContain('media-type="image/webp"');
		expect(result.messages).toEqual([]);
		expect(result.valid).toBe(true);
	});
});
