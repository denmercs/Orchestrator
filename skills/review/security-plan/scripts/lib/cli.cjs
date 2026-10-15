#!/usr/bin/env node
/**
 * Small shared helpers for the security-plan scripts. Nothing here reaches
 * outside the skill folder.
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');

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
		if (arg === '-h') {
			flags.help = true;
		} else if (arg.startsWith('--')) {
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
 * Print a usage error and exit 2.
 *
 * @param {string} message
 * @param {string} usage
 * @returns {never}
 */
function usageError(message, usage) {
	console.error(`${message}\n${usage}`);
	process.exit(2);
}

/**
 * Exit 2 when a flag that takes a value was given without one.
 *
 * @param {Record<string, string | boolean>} flags
 * @param {string[]} names
 * @param {string} usage
 */
function requireValues(flags, names, usage) {
	for (const name of names) {
		if (flags[name] === true || flags[name] === '') {
			usageError(`--${name} needs a value`, usage);
		}
	}
}

/**
 * @param {string | undefined} arg
 * @returns {string}
 */
function resolveConsumerRoot(arg) {
	return path.resolve(arg ?? process.cwd());
}

/**
 * Run a program with an argument array and no shell.
 *
 * @param {string} cwd
 * @param {string} bin
 * @param {string[]} args
 * @returns {{ stdout: string; stderr: string; status: number }}
 */
function run(cwd, bin, args) {
	const result = spawnSync(bin, args, {
		cwd,
		encoding: 'utf8',
		shell: false,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	if (result.error) {
		return { stdout: '', stderr: result.error.message, status: 1 };
	}
	return {
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		status: result.status ?? 1,
	};
}

/**
 * @param {string} consumerRoot
 * @param {string} [base]
 * @returns {string}
 */
function gitMergeBase(consumerRoot, base = 'main') {
	for (const ref of [`origin/${base}`, base]) {
		const result = run(consumerRoot, 'git', ['merge-base', 'HEAD', ref]);
		if (result.status === 0 && result.stdout.trim()) {
			return result.stdout.trim();
		}
	}
	return 'HEAD';
}

module.exports = { parseArgs, usageError, requireValues, resolveConsumerRoot, run, gitMergeBase };
