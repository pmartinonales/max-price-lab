import { startServer } from './server';

const { port } = await startServer();
console.log(`Max Price Lab on http://localhost:${port}`);
console.log(`Webhook endpoint: http://localhost:${port}/webhook (expose it with: ngrok http ${port})`);
