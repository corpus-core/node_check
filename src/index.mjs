#!/usr/bin/env node

import { check_node } from './beacon/index.mjs'

const url = process.argv.pop()
if (!url || url.endsWith('.mjs') || url.endsWith('node')) {
    console.error('Usage: node src/index.mjs <beacon_node_url>')
    console.error('   or: ./src/index.mjs <beacon_node_url>')
    console.error('Example: node src/index.mjs https://lodestar-mainnet.chainsafe.io')
    console.error('     or: ./src/index.mjs https://lodestar-mainnet.chainsafe.io')
    process.exit(1)
}

for (let node of url.split(',')) {
    console.log(`\n### Checking ${node}\n`)

    await check_node(node, (check, checks) => {
        const max_name_length = Math.max(...checks.map(r => r.name.length))
        console.log(`${check.name.padEnd(max_name_length + 2)}: ${check.passed ? '✅' : '❌'} ${check.result}`)
    })
}