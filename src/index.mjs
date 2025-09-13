#!/usr/bin/env node

import { check_beacon_node } from './beacon.mjs'
import { check_execution_node } from './execution.mjs'

const args = process.argv.slice(2)
const type = args[0]
const url = args[1]

const usage = () => {
    console.error('Usage: node src/index.mjs <type> <url>')
    console.error('   or: ./src/index.mjs <type> <url>')
    console.error('Types: beacon, execution')
    console.error('Example: node src/index.mjs beacon https://lodestar-mainnet.chainsafe.io')
    console.error('     or: ./src/index.mjs execution https://rpc.ankr.com/eth')
    process.exit(1)
}


if (!url || !type) {
    usage()
}

const check_function = {
    'beacon': check_beacon_node,
    'execution': check_execution_node
}[type]

if (!check_function) {
    console.error(`Invalid type: ${type}. Must be 'beacon' or 'execution'.`)
    usage()
}


for (let node of url.split(',')) {
    console.log(`\n### Checking ${type} node ${node}\n`)

    await check_function(node, (check, checks) => {
        const max_name_length = Math.max(...checks.map(r => r.name.length))
        console.log(`${check.name.padEnd(max_name_length + 2)}: ${check.passed ? '✅' : '❌'} ${check.result}`)
    })
}