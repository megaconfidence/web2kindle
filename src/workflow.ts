import send from './email';
import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';

type Payload = {
	email: string;
	url: string;
};

export class Workflow extends WorkflowEntrypoint<Env, Params> {
	async run(event: WorkflowEvent<Payload>, step: WorkflowStep) {
		const { url, email } = event.payload;
		const isPdfCached = await step.do('check for pdf in cache', async () => {
			const cache = await this.env.PDF_CACHE.list({ prefix: url });
			if (cache.keys.length > 0) return true;
			return false;
		});
		if (!isPdfCached) {
			await step.do('render new pdf and cache', async () => {
				console.log('pdf not found in cache. rendering new pdf');
				const id = this.env.BROWSER_CONTROLLER.idFromName('browser_controller');
				const obj = this.env.BROWSER_CONTROLLER.get(id);
				await obj.renderAndCache(url);
			});
		}
		const status = await step.do('send pdf in email', async () => {
			let pdf = await this.env.PDF_CACHE.get(url, { type: 'arrayBuffer' });
			return await send(this.env, email, pdf!, url);
		});
	}
}
