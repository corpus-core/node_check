import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { check_beacon_node } from './beacon.mjs';
import { check_execution_node } from './execution.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 8080;

app.use(express.json());

// Serve static files from the project root
app.use(express.static(path.join(__dirname, '..')));

app.post('/check', async (req, res) => {
    const { urls, clientType } = req.body;
    if (!urls || !clientType) {
        return res.status(400).json({ error: 'Missing urls or clientType' });
    }

    const check_function = clientType === 'beacon' ? check_beacon_node : check_execution_node;
    let all_results = [];

    try {
        for (const url of urls.replace(/,/g, ' ').split(/\s+/).filter(u => u)) {
            const trimmedUrl = url.trim();
            if (!trimmedUrl) continue;

            const results = await check_function(trimmedUrl);
            all_results.push({ url: trimmedUrl, results });
        }
        res.json(all_results);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(port, () => {
    console.log(`Server listening at http://localhost:${port}`);
});
