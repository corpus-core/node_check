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
            // Ignore JSON parse errors.
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

const MIN_ZK_PROOF_BYTES = 25_000;
const PROOF_BYTES = 668;
const MAX_ALLOWED_DELAY_SECONDS = 30;

class ColibriNode {
    constructor(url) {
        this.url = url.endsWith('/') ? url.slice(0, -1) : url;
        this.req_count = 0;
        this.req_time = 0;
    }

    async request(path, options = {}) {
        const start = Date.now();
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 7000);

        try {
            const response = await fetch(this.url + path, { ...options, signal: controller.signal });
            clearTimeout(timeoutId);
            this.req_count += 1;
            this.req_time += Date.now() - start;

            if (!response.ok) {
                let txt;
                try {
                    txt = await response.text().then((r) => r.trim());
                } catch {
                    txt = `HTTP ${response.status}`;
                }
                throw new Error(`HTTP ${response.status}: ${format_error_message(txt)}`);
            }
            return response;
        } catch (error) {
            clearTimeout(timeoutId);
            if (error.name === 'AbortError') {
                throw new Error('Request timed out after 7 seconds');
            }
            throw error;
        }
    }

    async json(path) {
        const response = await this.request(path, { method: 'GET' });
        return response.json();
    }

    async proof(zk_proof) {
        const response = await this.request('/proof', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                method: 'eth_blockNumber',
                params: [],
                zk_proof,
            }),
        });

        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('application/octet-stream')) {
            if (contentType.includes('application/json')) {
                const errorJson = await response.json();
                throw new Error(format_error_message(JSON.stringify(errorJson)));
            }
            throw new Error(`Unexpected content-type: ${contentType}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        return new Uint8Array(arrayBuffer);
    }

    get avg_time() {
        return (this.req_count ? this.req_time / this.req_count : 0).toFixed(2) + ' ms';
    }
}

function read_uint64_le(bytes, offset) {
    if (bytes.byteLength < offset + 8) {
        throw new Error('Proof payload too short to read uint64 value');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return Number(view.getBigUint64(offset, true));
}

function validate_proof(bytes, { expect_exact_size, min_size }) {
    if (expect_exact_size && bytes.byteLength !== expect_exact_size) {
        throw new Error(`Proof size mismatch, expected ${expect_exact_size} bytes, got ${bytes.byteLength}`);
    }
    if (min_size && bytes.byteLength < min_size) {
        throw new Error(`Proof size too small, expected at least ${min_size} bytes, got ${bytes.byteLength}`);
    }

    const blockNumber = read_uint64_le(bytes, 18);
    const timestamp = read_uint64_le(bytes, 26);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const delta = nowSeconds - timestamp;

    if (delta > MAX_ALLOWED_DELAY_SECONDS) {
        throw new Error(`Proof timestamp too old (block ${blockNumber}, Δ ${delta}s)`);
    }

    return { blockNumber, delta };
}

async function check_version(node) {
    const info = await node.json('/version');
    if (!info.vendor || !info.version) {
        throw new Error('Missing vendor or version information');
    }
    return `${info.vendor} ${info.version}`;
}

async function check_proof_non_zk(node) {
    const proof = await node.proof(false);
    const { blockNumber, delta } = validate_proof(proof, { expect_exact_size: PROOF_BYTES });
    return `ok (block ${blockNumber}, Δ ${delta}s)`;
}

async function check_proof_zk(node) {
    const proof = await node.proof(true);
    const { blockNumber, delta } = validate_proof(proof, { min_size: MIN_ZK_PROOF_BYTES });
    return `ok (block ${blockNumber}, Δ ${delta}s, size ${proof.byteLength} bytes)`;
}

export async function check_colibri_node(url, cb) {
    const node = new ColibriNode(url);
    const results = [];
    const checks = [
        { name: 'version', fn: check_version, required: true },
        { name: 'proof_eth_blockNumber (non-zk)', fn: check_proof_non_zk, required: true },
        { name: 'proof_eth_blockNumber (zk)', fn: check_proof_zk, required: true },
        { name: 'avg_response_time', fn: () => node.avg_time, required: false },
        {
            name: 'colibri suitable',
            fn: () => {
                if (required_checks_failed.length) {
                    throw new Error('required checks failed: ' + required_checks_failed.join(', '));
                }
                return 'ok';
            },
            required: false,
        },
    ];

    const required_checks_failed = [];
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

