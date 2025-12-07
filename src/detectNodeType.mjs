// Isomorphic helper to detect whether a node exposes the Beacon REST API or the Execution JSON-RPC API.
const DETECTION_TIMEOUT = 7000;

const rpcPayload = JSON.stringify({
    jsonrpc: '2.0',
    method: 'web3_clientVersion',
    params: [],
    id: 1,
});

const rpcHeaders = { 'Content-Type': 'application/json' };

const normalizeUrl = (rawUrl) => {
    if (!rawUrl || typeof rawUrl !== 'string') {
        throw new Error('Invalid URL provided');
    }
    const trimmed = rawUrl.trim();
    if (!trimmed) {
        throw new Error('Empty URL provided');
    }
    return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
};

const describeError = (error) => {
    if (!error) return 'unknown error';
    if (typeof error === 'string') return error;
    if (error.message) return error.message;
    try {
        return JSON.stringify(error);
    } catch {
        return 'unknown error';
    }
};

async function fetchWithTimeout(resource, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeout || DETECTION_TIMEOUT);
    const config = { ...options, signal: controller.signal };
    delete config.timeout;

    try {
        return await fetch(resource, config);
    } finally {
        clearTimeout(timeout);
    }
}

async function probeBeacon(url) {
    const response = await fetchWithTimeout(`${url}/eth/v1/node/version`, { method: 'GET' });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    // Ensure the endpoint responds with valid JSON
    await response.json();
    return 'beacon';
}

async function probeExecution(url) {
    const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: rpcHeaders,
        body: rpcPayload,
    });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    const json = await response.json();
    if (json && typeof json.result === 'string') {
        return 'execution';
    }
    if (json && json.error) {
        throw new Error(describeError(json.error));
    }
    throw new Error('Unexpected RPC response');
}

export async function detectNodeType(rawUrl) {
    const normalizedUrl = normalizeUrl(rawUrl);
    const [beaconResult, executionResult] = await Promise.allSettled([
        probeBeacon(normalizedUrl),
        probeExecution(normalizedUrl)
    ]);

    if (beaconResult.status === 'fulfilled') {
        return { type: 'beacon', url: normalizedUrl };
    }
    if (executionResult.status === 'fulfilled') {
        return { type: 'execution', url: normalizedUrl };
    }

    const beaconError = describeError(beaconResult.reason);
    const executionError = describeError(executionResult.reason);

    throw new Error(`Unable to detect node type (Beacon: ${beaconError}, Execution: ${executionError})`);
}

