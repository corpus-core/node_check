// Isomorphic environment setup
const isBrowser = typeof window !== 'undefined';

let crypto, fs, Buffer;

if (isBrowser) {
    crypto = window.crypto;
    Buffer = Uint8Array;
} else {
    // Using dynamic import for Node.js modules
    await (async () => {
        crypto = (await import('crypto')).default;
        fs = (await import('fs')).default;
        Buffer = (await import('buffer')).Buffer;
    })();
}

// --- Helper functions ---

const hash = async (...values) => {
    const data = isBrowser ? concat_buffers(values.map(v => fromHex(v))) : Buffer.concat(values.map(v => fromHex(v)));
    if (isBrowser) {
        return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
    } else {
        return crypto.createHash("sha256").update(data).digest();
    }
};

const hash_roots = async (roots) => {
    const results = [];
    for (let i = 0; i < roots.length; i += 2) {
        results.push(await hash(roots[i], (roots[i + 1] || (isBrowser ? new Uint8Array(32) : Buffer.alloc(32)))));
    }
    return results;
};

const hash_key = (key) => hash(key, (isBrowser ? new Uint8Array(16) : Buffer.alloc(16)));

const fromHex = (hex) => {
    if (hex instanceof Uint8Array || (Buffer && hex instanceof Buffer)) return hex;
    const hexString = hex.toString().startsWith("0x") ? hex.substring(2) : hex;
    if (isBrowser) {
        const bytes = new Uint8Array(hexString.length / 2);
        for (let i = 0; i < bytes.length; i++) {
            bytes[i] = parseInt(hexString.substr(i * 2, 2), 16);
        }
        return bytes;
    } else {
        return Buffer.from(hexString, "hex");
    }
};

const concat_buffers = (buffers) => {
    if (!isBrowser) return Buffer.concat(buffers);
    let totalLength = 0;
    for (const b of buffers) totalLength += b.length;
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const b of buffers) {
        result.set(b, offset);
        offset += b.length;
    }
    return result;
}

const compare_buffers = (a, b) => {
    if (!isBrowser) return Buffer.compare(a, b);
    if (a.length !== b.length) return 1;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return 1;
    }
    return 0;
}

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


const split_bytes = (bytes, len) => new Array(Math.ceil(bytes.length / len)).fill(0).map((_, i) => bytes.slice(i * len, (i + 1) * len));
const ELECTRA_NEXT_SYNC_COMMITTEE_GINDEX = 87;

async function calculate_next_sync_committee_root(next_sync_committee) {
    let roots = await Promise.all(next_sync_committee.pubkeys.map(hash_key));
    while (roots.length > 1) roots = await hash_roots(roots);
    return await hash(roots[0], await hash_key(next_sync_committee.aggregate_pubkey));
}

async function merkle_root_from_branch(gindex, branch, leaf) {
    let root = leaf, i = 0;
    while (gindex > 1) {
        root = gindex % 2 ? await hash(branch[i++], root) : await hash(root, branch[i++]);
        gindex = typeof gindex === 'bigint' ? gindex >> 1n : gindex >> 1;
    }
    return root;
}

class Node {
    constructor(url) {
        this.url = url.endsWith('/') ? url.slice(0, -1) : url;
        this.req_count = 0;
        this.req_time = 0;
    }

    async exec(path, query, ssz) {
        let headers = {};
        if (ssz) headers['Accept'] = 'application/octet-stream';
        if (query) path += '?' + Object.entries(query).map(([key, value]) => `${key}=${value}`).join('&');
        const start_time = Date.now();
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 7000);

        try {
            const response = await fetch(this.url + path, { method: 'GET', headers, signal: controller.signal });
            clearTimeout(timeoutId);

            if (response.status !== 200) {
                let txt = await response.text().then(r => r.trim());
                throw new Error(format_error_message(txt));
            }
            this.req_count += 1;
            this.req_time += Date.now() - start_time;
            if (ssz) {
                const content_type = response.headers.get('Content-Type');
                if (content_type.includes('application/octet-stream')) {
                    const buffer = await response.arrayBuffer();
                    return isBrowser ? new Uint8Array(buffer) : Buffer.from(buffer);
                } else if (content_type.includes('application/json')) {
                    const json = await response.json();
                    if (json.data || Array.isArray(json)) throw new Error('SSZ requested, but json delivered for ' + path);
                    if (json.code && json.message) throw new Error(format_error_message(json.message + ' ssz requested, but json delivered'));
                    throw new Error(`SSZ not supported for ${path} ( ${content_type} )`);
                } else {
                    throw new Error(`SSZ not supported for ${path} ( ${content_type} )`);
                }
            }
            return await response.json();
        } catch (error) {
            clearTimeout(timeoutId);
            if (error.name === 'AbortError') {
                throw new Error('Request timed out after 7 seconds');
            }
            throw error;
        }
    }

    async json(path, query) {
        return this.exec(path, query, false);
    }

    async ssz(path, query) {
        return this.exec(path, query, true);
    }

    get avg_time() {
        return (this.req_count ? this.req_time / this.req_count : 0).toFixed(2) + ' ms';
    }

    get is_file() {
        return !isBrowser && !this.url.startsWith('http://') && !this.url.startsWith('https://');
    }

    get file_content() {
        if (!this.is_file) throw new Error('Not a file');
        return fs.readFileSync(this.url);
    }
}

async function check_version(node) {
    const info = await node.json('/eth/v1/node/version');
    return info.data.version;
}

async function check_parent_headers(node) {
    const head = await node.json('/eth/v1/beacon/headers/head').then(r => r.data);
    const found = await node.json('/eth/v1/beacon/headers', { parent_root: head.header.message.parent_root }).then(r => r.data);
    if (!found || found.length !== 1) throw new Error(`Parent header not found: ${head.header.message.parent_root}`);
    if (found[0].header.message.parent_root !== head.header.message.parent_root) throw new Error(`Parent header mismatch: ${found[0].header.message.parent_root} !== ${head.header.message.parent_root}`);
    return 'ok';
}

async function check_cors(node) {
    if (isBrowser) {
        try {
            await node.json('/eth/v1/node/version');
            return 'ok';
        } catch (e) {
            throw new Error('Request failed, likely due to restrictive CORS policy.');
        }
    } else {
        const response = await fetch(node.url + '/eth/v1/node/version', {
            method: 'GET',
            headers: { 'Origin': 'https://example.com' }
        });
        const acao = response.headers.get('access-control-allow-origin');
        if (acao === '*') {
            return `ok (*)`;
        }
        if (acao) throw new Error(`CORS header is restrictive, only allows: ${acao}`);
        throw new Error('CORS header (access-control-allow-origin) not found');
    }
}

async function check_sse_events(node) {
    const url = node.url + '/eth/v1/events?topics=head';
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            if (isBrowser && typeof es !== 'undefined') {
                es.close();
            } else if (!isBrowser && typeof controller !== 'undefined') {
                controller.abort();
            }
            reject(new Error('Timeout: No head event received within 15 seconds.'));
        }, 15000);

        let es, controller;

        if (isBrowser) {
            es = new EventSource(url);
            es.addEventListener('head', () => {
                clearTimeout(timeout);
                es.close();
                resolve('ok');
            });
            es.onerror = () => {
                clearTimeout(timeout);
                es.close();
                reject(new Error('Error connecting to event stream.'));
            };
        } else { // Node.js
            controller = new AbortController();
            fetch(url, { signal: controller.signal }).then(async response => {
                if (!response.ok) {
                    clearTimeout(timeout);
                    return reject(new Error(`Failed to connect to event stream: ${response.statusText}`));
                }
                for await (const chunk of response.body) {
                    if (new TextDecoder().decode(chunk).includes('event: head')) {
                        clearTimeout(timeout);
                        controller.abort();
                        return resolve('ok');
                    }
                }
                clearTimeout(timeout);
                reject(new Error('Stream ended without a head event.'));
            }).catch(err => {
                if (err.name !== 'AbortError') {
                    clearTimeout(timeout);
                    reject(err);
                }
            });
        }
    });
}

async function check_block_ssz(node) {
    const head = await node.json('/eth/v1/beacon/headers/head').then(r => r.data.header);
    const blockBuffer = await node.ssz('/eth/v2/beacon/blocks/head');
    const block = new DataView(blockBuffer.buffer, blockBuffer.byteOffset, blockBuffer.byteLength);
    if (block.byteLength < 8) throw new Error(`Block is too short: ${block.byteLength}`);
    const offset = block.getUint32(0, true);
    if (offset > block.byteLength - 4) throw new Error('Invalid offset in ssz block');
    const slot = Number(block.getBigUint64(offset, true));
    if (Math.abs(slot - parseInt(head.message.slot)) > 1) throw new Error('Invalid slot in block');
    return 'ok';
}

async function historical_proof(node) {
    const client = await check_version(node);
    if (!client.includes('Nimbus') && !client.includes('Lodestar')) throw new Error('not supported');
    return 'ok';
}

async function check_lcu_json(node) {
    const slot = await node.json('/eth/v1/beacon/headers/head').then(r => r.data.header.message.slot);
    const period = slot >> 13;
    for (let i = 0; i < 21; i++) {
        const data = await node.json('/eth/v1/beacon/light_client/updates', { start_period: period - i, count: 1 }).then(r => r[0].data);
        const sync_root = await calculate_next_sync_committee_root(data.next_sync_committee);
        const state_root_calculated = await merkle_root_from_branch(ELECTRA_NEXT_SYNC_COMMITTEE_GINDEX, data.next_sync_committee_branch.map(fromHex), sync_root);
        const state_root_expected = fromHex(data.attested_header.beacon.state_root);

        if (compare_buffers(state_root_calculated, state_root_expected) !== 0) throw new Error(`Invalid Merkle Proof : State root mismatch (i: ${i})`);
    }
    return 'ok';
}

async function check_lcu_ssz(node) {
    let data = null;
    if (node.is_file) {
        data = node.file_content;
    } else {
        const slot = await node.json('/eth/v1/beacon/headers/head').then(r => r.data.header.message.slot);
        const period = slot >> 13;
        data = await node.ssz('/eth/v1/beacon/light_client/updates', { start_period: period, count: 1 });
    }

    // SSZ decoding logic...
    // This part is tricky and might need a proper SSZ library to work robustly.
    // The DataView/Buffer slicing approach is kept for now.

    function decode_ssz(ssz_data) {
        const view = new DataView(ssz_data.buffer, ssz_data.byteOffset, ssz_data.byteLength);

        let offset = { start: 4 };
        function read_ssz(len) {
            const value = ssz_data.slice(offset.start, offset.start + len);
            offset.start += len;
            return value;
        }

        const next_sync_committee = read_ssz(513 * 48);
        const next_sync_committee_branch = read_ssz(6 * 32);
        const attested_header_offset = view.getUint32(0, true);
        const attested_header_end_offset = view.getUint32(offset.start, true);
        const attested_header = ssz_data.slice(attested_header_offset, attested_header_end_offset);

        return {
            state_root: attested_header.slice(48, 48 + 32),
            next_sync_committee: {
                pubkeys: split_bytes(next_sync_committee.slice(0, 512 * 48), 48),
                aggregate_pubkey: next_sync_committee.slice(512 * 48, 513 * 48)
            },
            next_sync_committee_branch: split_bytes(next_sync_committee_branch, 32)
        };
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const update = decode_ssz(data.slice(12, 12 + view.getUint32(0, true)));

    const sync_root = await calculate_next_sync_committee_root(update.next_sync_committee);
    const state_root_calculated = await merkle_root_from_branch(ELECTRA_NEXT_SYNC_COMMITTEE_GINDEX, update.next_sync_committee_branch, sync_root);
    const state_root_expected = update.state_root;

    if (compare_buffers(state_root_calculated, state_root_expected) !== 0) throw new Error("State root mismatch");

    return 'ok';
}

export async function check_beacon_node(url, cb) {
    const node = new Node(url);
    const results = [];
    const checks = node.is_file ? [
        { name: 'light_client_update as ssz', fn: check_lcu_ssz, required: true },
    ] : [
        { name: 'version', fn: check_version, required: true },
        { name: 'headers_by_parent', fn: check_parent_headers, required: true },
        { name: 'cors_headers', fn: check_cors, required: false },
        { name: 'sse_events', fn: check_sse_events, required: false },
        { name: 'block_as_ssz', fn: check_block_ssz, required: false },
        { name: 'light_client_update as ssz', fn: check_lcu_ssz, required: false },
        { name: 'light_client_update as json', fn: check_lcu_json, required: true },
        { name: 'historical_proof', fn: historical_proof, required: false },
        { name: 'avg_response_time', fn: () => node.avg_time, required: false },
        { name: 'colibri suitable', fn: () => { if (required_checks_failed.length) throw new Error('required checks failed: ' + required_checks_failed.join(', ')); return 'ok' }, required: false },
    ];

    let required_checks_failed = [];
    for (const check of checks) {
        try {
            const result = await check.fn(node);
            results.push({ name: check.name, result, passed: true });
        } catch (error) {
            if (check.required) required_checks_failed.push(check.name);
            results.push({ name: check.name, result: error.message, passed: false });
        }
        if (cb) cb(results[results.length - 1], checks);
    }
    return results;
}