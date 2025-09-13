// Isomorphic environment setup
const isBrowser = typeof window !== 'undefined';

class ExecutionNode {
    constructor(url) {
        this.url = url.endsWith('/') ? url.slice(0, -1) : url;
        this.req_count = 0;
        this.req_time = 0;
        this.id = 1;
    }

    async rpc(method, params) {
        const start_time = Date.now();
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
        });
        this.req_count += 1;
        this.req_time += Date.now() - start_time;

        if (response.status !== 200) {
            const txt = await response.text().then(r => r.trim());
            throw new Error(`HTTP Error ${response.status}: ${txt}`);
        }

        const json = await response.json();
        if (json.error) {
            throw new Error(`RPC Error: ${json.error.message} (code: ${json.error.code})`);
        }
        return json.result;
    }

    get avg_time() {
        return (this.req_count ? this.req_time / this.req_count : 0).toFixed(2) + ' ms';
    }
}

async function check_client_version(node) {
    return await node.rpc('web3_clientVersion');
}

async function check_debug_trace_call(node) {
    try {
        await node.rpc('debug_traceCall', [{}, 'latest']);
    } catch (e) {
        if (e.message.includes('method not found') || e.message.includes('not available')) {
            throw e;
        }
    }
    return 'available';
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
        { name: 'debug_traceCall', fn: check_debug_trace_call, required: false },
        { name: 'eth_getProof', fn: check_eth_get_proof, required: true },
        { name: `archive_check (latest-${ARCHIVE_DEPTH.toLocaleString()})`, fn: (node) => check_historical_transaction_count(node, ARCHIVE_DEPTH), required: false },
        { name: 'avg_response_time', fn: () => node.avg_time, required: false },
    ];

    for (const check of checks) {
        let result_obj;
        try {
            const result = await check.fn(node);
            result_obj = { name: check.name, result, passed: true };
        } catch (error) {
            result_obj = { name: check.name, result: error.message, passed: false };
        }
        results.push(result_obj);
        if (cb) cb(result_obj, checks);
    }
    return results;
}
