// Isomorphic environment setup
const isBrowser = typeof window !== 'undefined';

function format_error_message(message) {
    if (typeof message !== 'string') return message;

    const trimmed_message = message.trim();
    if (trimmed_message.startsWith('{') && trimmed_message.endsWith('}')) {
        try {
            const json = JSON.parse(trimmed_message);
            const error_obj = json.error || json;
            if (error_obj.message) {
                let msg = error_obj.message;
                if (error_obj.code) {
                    msg += ` (code: ${error_obj.code})`;
                }
                return msg;
            }
        } catch (e) {
            // Not JSON, continue to HTML stripping
        }
    }

    if (message.includes('<')) {
        let text_to_clean = message;
        const body_start_index = message.toLowerCase().indexOf('<body');
        if (body_start_index !== -1) {
            const body_content_start_index = message.indexOf('>', body_start_index) + 1;
            const body_end_index = message.toLowerCase().lastIndexOf('</body>');
            if (body_content_start_index > 0) {
                text_to_clean = message.substring(body_content_start_index, body_end_index !== -1 ? body_end_index : undefined);
            }
        }
        return text_to_clean.replace(/<[^>]+>/g, ' ').replace(/\s\s+/g, ' ').trim();
    }

    return message;
}

class ExecutionNode {
    constructor(url) {
        this.url = url.endsWith('/') ? url.slice(0, -1) : url;
        this.req_count = 0;
        this.req_time = 0;
        this.id = 1;
    }

    async rpc(method, params) {
        const start_time = Date.now();
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 7000);

        try {
            const response = await fetch(this.url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    method,
                    params: params || [],
                    id: this.id++,
                }),
                signal: controller.signal,
            });
            clearTimeout(timeoutId);
            this.req_count += 1;
            this.req_time += Date.now() - start_time;

            if (response.status !== 200) {
                const txt = await response.text().then(r => r.trim());
                throw new Error(`HTTP Error ${response.status}: ${format_error_message(txt)}`);
            }

            const json = await response.json();
            if (json.error) {
                throw new Error(`RPC Error: ${format_error_message(JSON.stringify(json.error))}`);
            }
            return json.result;
        } catch (error) {
            clearTimeout(timeoutId);
            if (error.name === 'AbortError') {
                throw new Error('Request timed out after 7 seconds');
            }
            throw error;
        }
    }

    get avg_time() {
        return (this.req_count ? this.req_time / this.req_count : 0).toFixed(2) + ' ms';
    }
}

async function check_client_version(node) {
    return await node.rpc('web3_clientVersion');
}

async function check_cors(node) {
    if (isBrowser) {
        try {
            await node.rpc('web3_clientVersion');
            return 'ok';
        } catch (e) {
            throw new Error('Request failed, likely due to restrictive CORS policy.');
        }
    } else {
        const response = await fetch(node.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Origin': 'https://example.com'
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                method: 'web3_clientVersion',
                params: [],
                id: 999
            }),
        });
        const acao = response.headers.get('access-control-allow-origin');
        if (acao === '*') {
            return `ok (*)`;
        }
        if (acao) throw new Error(`CORS header is restrictive, only allows: ${acao}`);
        throw new Error('CORS header (access-control-allow-origin) not found');
    }
}

async function check_debug_trace_call(node) {
    // This is a more robust check that specifically tests for the `prestateTracer`.
    // Some RPC providers keep `debug_traceCall` but disable costly tracers.
    await node.rpc('debug_traceCall', [{}, 'latest', {
        tracer: 'prestateTracer'
    }]);
    return 'available (with prestateTracer)';
}

async function check_eth_create_access_list(node) {
    await node.rpc('eth_createAccessList', [{}, 'latest']);
    return 'ok';
}

async function check_eth_get_proof(node) {
    const latest_block_hex = await node.rpc('eth_blockNumber');
    const latest_block = BigInt(latest_block_hex);
    const historical_block = '0x' + (latest_block - 2n).toString(16);
    const address = '0x0000000000000000000000000000000000000000';
    const storageKeys = [];

    try {
        await node.rpc('eth_getProof', [address, storageKeys, historical_block]);
        return 'ok (historical state supported)';
    } catch (historical_error) {
        try {
            await node.rpc('eth_getProof', [address, storageKeys, 'latest']);
            return 'ok (latest state only)';
        } catch (latest_error) {
            throw latest_error;
        }
    }
}

async function check_eth_get_block_receipts(node) {
    const receipts = await node.rpc('eth_getBlockReceipts', ['latest']);
    if (!Array.isArray(receipts)) {
        throw new Error('Response is not an array of receipts');
    }
    return `ok, ${receipts.length} receipts in latest block`;
}

async function check_historical_transaction_count(node, depth) {
    const latest_block_hex = await node.rpc('eth_blockNumber');
    const latest_block = BigInt(latest_block_hex);
    const target_block_number = latest_block - BigInt(depth);

    if (target_block_number < 0) {
        throw new Error(`Cannot check depth ${depth}, latest block is ${latest_block}`);
    }

    const target_block = '0x' + target_block_number.toString(16);
    const address = '0x0000000000000000000000000000000000000000';
    await node.rpc('eth_getTransactionCount', [address, target_block]);
    return 'ok';
}

export async function check_execution_node(url, cb) {
    const node = new ExecutionNode(url);
    const results = [];
    const ARCHIVE_DEPTH = 100000;
    const checks = [
        { name: 'web3_clientVersion', fn: check_client_version, required: true },
        { name: 'cors_headers', fn: check_cors, required: false },
        { name: 'debug_traceCall', fn: check_debug_trace_call, required: true },
        { name: 'eth_createAccessList', fn: check_eth_create_access_list, required: false },
        { name: 'eth_getProof', fn: check_eth_get_proof, required: true },
        { name: 'eth_getBlockReceipts', fn: check_eth_get_block_receipts, required: true },
        { name: `archive_check (latest-${ARCHIVE_DEPTH.toLocaleString()})`, fn: (node) => check_historical_transaction_count(node, ARCHIVE_DEPTH), required: false },
        { name: 'avg_response_time', fn: () => node.avg_time, required: false },
        { name: 'colibri suitable', fn: () => { if (required_checks_failed.length) throw new Error('required checks failed: ' + required_checks_failed.join(', ')); return 'ok' }, required: false },
    ];

    let required_checks_failed = [];
    for (const check of checks) {
        let result_obj;
        try {
            const result = await check.fn(node);
            result_obj = { name: check.name, result, passed: true };
        } catch (error) {
            if (check.required) required_checks_failed.push(check.name);
            result_obj = { name: check.name, result: error.message, passed: false };
        }
        results.push(result_obj);
        if (cb) cb(result_obj, checks);
    }
    return results;
}
