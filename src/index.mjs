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


let suitable_nodes = [];
for (let node of url.replace(/,/g, ' ').split(/\s+/).filter(u => u)) {
    console.log(`\n### Checking ${type} node ${node}\n`)

    const results = await check_function(node, (check, checks) => {
        const max_name_length = Math.max(...checks.map(r => r.name.length))
        const check_definition = checks.find(c => c.name === check.name);
        const is_required = check_definition ? check_definition.required : false;

        let symbol;
        if (check.name === 'colibri suitable') {
            symbol = check.passed ? '✅' : '❌';
        } else {
            symbol = check.passed ? '✅' : (is_required ? '❌' : '⚠️');
        }
        console.log(`${check.name.padEnd(max_name_length + 2)}: ${symbol} ${check.result}`)
    })

    const suitability_check = results.find(r => r.name === 'colibri suitable');
    if (suitability_check && suitability_check.passed) {
        suitable_nodes.push(node);
    }
}

console.log(`\n\n--- Summary ---`);
console.log(`Suitable ${type} nodes that passed all required checks:`);
if (suitable_nodes.length > 0) {
    suitable_nodes.forEach(n => console.log(`- ${n}`));
} else {
    console.log('None of the provided nodes are suitable.');
}
console.log('------------------------------------------');