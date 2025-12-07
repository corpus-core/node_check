#!/usr/bin/env node

import { check_beacon_node } from './beacon.mjs'
import { check_execution_node } from './execution.mjs'
import { detectNodeType } from './detectNodeType.mjs'

const args = process.argv.slice(2)

const usage = () => {
    console.error('Usage: node src/index.mjs <url> [additional URLs]')
    console.error('   or: ./src/index.mjs <url> [additional URLs]')
    console.error('Example: node src/index.mjs https://lodestar-mainnet.chainsafe.io')
    console.error('     or: ./src/index.mjs https://rpc.ankr.com/eth https://another.node')
    process.exit(1)
}

if (!args.length) {
    usage()
}

const parseUrls = (value) => value
    .replace(/,/g, ' ')
    .split(/\s+/)
    .map(u => u.trim())
    .filter(Boolean)

const nodes = parseUrls(args.join(' '))

if (!nodes.length) {
    usage()
}

const CHECK_MAP = {
    beacon: check_beacon_node,
    execution: check_execution_node,
}

const suitable_nodes = []
for (const node of nodes) {
    try {
        const { type, url } = await detectNodeType(node)
        const check_function = CHECK_MAP[type]
        if (!check_function) {
            throw new Error(`Unsupported node type detected: ${type}`)
        }

        console.log(`\n### Checking ${type} node ${node}\n`)

        const results = await check_function(url, (check, checks) => {
            const max_name_length = Math.max(...checks.map(r => r.name.length))
            const check_definition = checks.find(c => c.name === check.name);
            const is_required = check_definition ? check_definition.required : false;

            let symbol
            if (check.name === 'colibri suitable') {
                symbol = check.passed ? '✅' : '❌'
            } else {
                symbol = check.passed ? '✅' : (is_required ? '❌' : '⚠️')
            }
            console.log(`${check.name.padEnd(max_name_length + 2)}: ${symbol} ${check.result}`)
        })

        const suitability_check = results.find(r => r.name === 'colibri suitable')
        if (suitability_check && suitability_check.passed) {
            suitable_nodes.push({ url: node, type })
        }
    } catch (error) {
        console.error(`Failed to check node ${node}: ${error.message}`)
    }
}

console.log(`\n\n--- Summary ---`)
console.log(`Suitable nodes that passed all required checks:`)
if (suitable_nodes.length > 0) {
    suitable_nodes.forEach(({ url, type }) => console.log(`- [${type}] ${url}`))
} else {
    console.log('None of the provided nodes are suitable.')
}
console.log('------------------------------------------')