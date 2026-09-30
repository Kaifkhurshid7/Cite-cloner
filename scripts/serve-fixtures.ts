// Serves ./fixtures on http://localhost:5055/<name>/ – offline test sites for the agent.
import express from 'express';
import path from 'node:path';
import { ROOT } from '../src/agent/config.js';

const app = express();
app.use(express.static(path.join(ROOT, 'fixtures')));
const port = Number(process.env.FIXTURE_PORT ?? 5055);
app.listen(port, () => console.log(`fixtures on http://localhost:${port}/{saas,bakery,portfolio}/`));
