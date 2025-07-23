import { createHash } from 'crypto'


const hash = (...values) => createHash("sha256").update(Buffer.concat(values.map(fromHex))).digest()
const hash_roots = (roots) => new Array(roots.length / 2).fill(0).map((_, i) => hash(roots[i * 2], (roots[i * 2 + 1] || Buffer.alloc(32))))
const hash_key = (key) => hash(key, Buffer.alloc(16))
const fromHex = (hex) => Buffer.isBuffer(hex) ? hex : Buffer.from(hex.replace("0x", ""), "hex")
const split_bytes = (bytes, len) => new Array(bytes.length / len).fill(0).map((_, i) => bytes.slice(i * len, (i + 1) * len))
const ELECTRA_NEXT_SYNC_COMMITTEE_GINDEX = 87 // used to be 55 before electra

function calculate_next_sync_committee_root(next_sync_committee) {
    let roots = next_sync_committee.pubkeys.map(hash_key) // adding 16 bytes of padding
    while (roots.length > 1) roots = hash_roots(roots)
    return hash(roots[0], hash_key(next_sync_committee.aggregate_pubkey))
}


function merkle_root_from_branch(gindex, branch, leaf) {
    let root = leaf, i = 0
    while (gindex > 1) {
        root = gindex % 2 ? hash(branch[i++], root) : hash(root, branch[i++])
        gindex >>= 1
    }
    return root
}

class Node {

    constructor(url) {
        this.url = url.endsWith('/') ? url.slice(0, -1) : url;
        this.req_count = 0
        this.req_time = 0
    }
    async exec(path, query, ssz) {

        let headers = {}
        if (ssz) headers['Accept'] = 'application/octet-stream'
        if (query) path += '?' + Object.entries(query).map(([key, value]) => `${key}=${value}`).join('&')
        const start_time = Date.now()
        const response = await fetch(this.url + path, { method: 'GET', headers })
        if (response.status !== 200) {
            let txt = await response.text().then(r => r.trim())
            if (txt.startsWith('{') && txt.endsWith('}')) {
                let json = JSON.parse(txt)
                if (json.code && json.message) throw new Error(json.message)
                if (json.title) throw new Error(json.title)
            }
            throw new Error(txt)
        }
        this.req_count += 1
        this.req_time += Date.now() - start_time
        if (ssz) {
            const content_type = response.headers.get('Content-Type')
            if (content_type.includes('application/octet-stream'))
                return await response.arrayBuffer()
            else if (content_type.includes('application/json')) {
                const json = await response.json()
                if (json.data || Array.isArray(json)) throw new Error('SSZ requested, but json delivered for ' + path)
                if (json.code && json.message) throw new Error(json.message + ' ssz requested, but json delivered')
                throw new Error(`SSZ not supported for ${path} ( ${content_type} )`)
            }

            else
                throw new Error(`SSZ not supported for ${path} ( ${content_type} )`)
        }
        return await response.json();
    }

    async json(path, query) {
        return this.exec(path, query, false)
    }
    async ssz(path, query) {
        return this.exec(path, query, true)
    }

    get avg_time() {
        return (this.req_count ? this.req_time / this.req_count : 0).toFixed(2) + ' ms'
    }

}

async function check_version(node) {
    const info = await node.json('/eth/v1/node/version')
    return info.data.version
}

async function check_parent_headers(node) {
    const head = await node.json('/eth/v1/beacon/headers/head').then(r => r.data)
    const found = await node.json('/eth/v1/beacon/headers', { parent_root: head.header.message.parent_root }).then(r => r.data)
    if (!found || found.length !== 1) throw new Error(`Parent header not found: ${head.header.message.parent_root}`)
    if (found[0].header.message.parent_root !== head.header.message.parent_root) throw new Error(`Parent header mismatch: ${found[0].header.message.parent_root} !== ${head.header.message.parent_root}`)
    return 'ok'
}

async function check_block_ssz(node) {
    const head = await node.json('/eth/v1/beacon/headers/head').then(r => r.data.header)
    const block = new DataView(await node.ssz('/eth/v2/beacon/blocks/head'))
    if (block.length < 8) throw new Error(`Block is too short: ${block.length}`)
    const offset = block.getUint32(0, true)
    if (offset > block.length - 4) throw new Error('Invalid offset in ssz block')
    const slot = Number(block.getBigUint64(offset, true))
    if (Math.abs(slot - parseInt(head.message.slot)) > 1) throw new Error('Invalid slot in block')
    return 'ok'
}
async function historical_proof(node) {
    const client = await check_version(node)
    if (!client.includes('Nimbus') && !client.includes('Lodestar')) throw new Error('not supported')
    return 'ok'
}


async function check_lcu_json(node) {
    const slot = await node.json('/eth/v1/beacon/headers/head').then(r => r.data.header.message.slot)
    const period = slot >> 13
    for (let i = 0; i < 10; i++) {
        const data = await node.json('/eth/v1/beacon/light_client/updates', { start_period: period - i, count: 1 }).then(r => r[0].data)
        const sync_root = calculate_next_sync_committee_root(data.next_sync_committee)
        const state_root_calculated = merkle_root_from_branch(ELECTRA_NEXT_SYNC_COMMITTEE_GINDEX, data.next_sync_committee_branch, sync_root) // we only check electra states
        const state_root_expected = fromHex(data.attested_header.beacon.state_root)

        // check
        if (Buffer.compare(state_root_calculated, state_root_expected)) throw new Error(`Invalid Merkle Proof : State root mismatch (i: ${i})`)
    }

    return 'ok'
}
async function check_lcu_ssz(node) {
    const slot = await node.json('/eth/v1/beacon/headers/head').then(r => r.data.header.message.slot)
    const period = slot >> 13
    const data = await node.ssz('/eth/v1/beacon/light_client/updates', { start_period: period, count: 1 }).then(r => Buffer.from(r))

    function decode_ssz(data) {
        function read_ssz(bytes, len) {
            const value = bytes.slice(offset.start, offset.start + len)
            offset.start += len
            return value
        }
        // decode ssz
        let offset = { start: 4 }
        const next_sync_committee = read_ssz(data, 513 * 48) // 512 keys + aggregated pubkey (48 bytes)
        const next_sync_committee_branch = read_ssz(data, 6 * 32) // 6 hashes in the branch ( for electra)  
        const attested_header = data.slice(data.readUInt32LE(0), data.readUInt32LE(offset.start)) // dynamic object between the offsets
        return {
            state_root: attested_header.slice(48, 48 + 32), // just take the stateroot out of the fixed header
            next_sync_committee: {
                pubkeys: split_bytes(next_sync_committee.slice(0, 512 * 48), 48),
                aggregate_pubkey: next_sync_committee.slice(512 * 48, 513 * 48)
            },
            next_sync_committee_branch: split_bytes(next_sync_committee_branch, 32)
        }
    }

    // decode the first chunk, by reading the length from the first 8 bytes and skipping the forkDigest since we expect electra
    const update = decode_ssz(data.slice(12, 12 + data.slice(0, 8).readUInt32LE(0)))

    // calculate the state_root
    const sync_root = calculate_next_sync_committee_root(update.next_sync_committee)
    const state_root_calculated = merkle_root_from_branch(ELECTRA_NEXT_SYNC_COMMITTEE_GINDEX, update.next_sync_committee_branch, sync_root) // we only check electra states
    const state_root_expected = update.state_root

    // check
    if (Buffer.compare(state_root_calculated, state_root_expected)) throw new Error("State root mismatch")

    return 'ok'
}


export async function check_node(url, cb) {
    const node = new Node(url)
    const results = []
    const checks = [
        { name: 'version', fn: check_version, required: true },
        { name: 'headers_by_parent', fn: check_parent_headers, required: true },
        { name: 'block_as_ssz', fn: check_block_ssz, required: false },
        { name: 'light_client_update as ssz', fn: check_lcu_ssz, required: false },
        { name: 'light_client_update as json', fn: check_lcu_json, required: true },
        { name: 'historical_proof', fn: historical_proof, required: false },
        { name: 'avg_response_time', fn: node => node.avg_time, required: false },
        { name: '\ncolibri suitable', fn: () => { if (required_checks_failed.length) throw new Error('required checks failed: ' + required_checks_failed.join(', ')); return 'ok' }, required: false },

    ]

    let required_checks_failed = []
    for (const check of checks) {
        try {
            const result = await check.fn(node)
            results.push({ name: check.name, result, passed: true })
        } catch (error) {
            if (check.required) required_checks_failed.push(check.name)
            results.push({ name: check.name, result: error.message, passed: false })
        }
        if (cb) cb(results[results.length - 1], checks)
    }



    return results
}