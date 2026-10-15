#!/usr/bin/env node
/**
 * Small shared helpers for the plan-html scripts.
 */

const path = require('node:path');

/**
 * @typedef {object} ParsedArgs
 * @property {string[]} positional
 * @property {Record<string, string | boolean>} flags
 */

/**
 * @param {string[]} argv
 * @returns {ParsedArgs}
 */
function parseArgs(argv) {
	/** @type {string[]} */
	const positional = [];
	/** @type {Record<string, string | boolean>} */
	const flags = {};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg.startsWith('--')) {
			const eq = arg.indexOf('=');
			if (eq !== -1) {
				flags[arg.slice(2, eq)] = arg.slice(eq + 1);
			} else {
				const key = arg.slice(2);
				const next = argv[i + 1];
				if (next !== undefined && !next.startsWith('--')) {
					flags[key] = next;
					i++;
				} else {
					flags[key] = true;
				}
			}
		} else {
			positional.push(arg);
		}
	}

	return { positional, flags };
}

/**
 * @param {string | undefined} arg
 * @returns {string}
 */
function resolveConsumerRoot(arg) {
	return path.resolve(arg ?? process.cwd());
}

/**
 * @param {string} consumerRoot
 * @returns {import('node:fs').PathLike}
 */
function harnessDir(consumerRoot) {
	return path.join(consumerRoot, '.harness');
}

/**
 * @param {boolean} condition
 * @param {string} message
 */
function assertOrExit(condition, message) {
	if (!condition) {
		console.error(message);
		process.exit(1);
	}
}

module.exports = { parseArgs, resolveConsumerRoot, harnessDir, assertOrExit };
