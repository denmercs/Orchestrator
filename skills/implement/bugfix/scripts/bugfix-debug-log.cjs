#!/usr/bin/env node
/**
 * Local debug-log ingest for the bugfix skill (Cursor Debug Mode analogue).
 * Listens on 127.0.0.1, appends NDJSON to `.harness/debug-<tag>.log`.
 *
 * Usage (repo root):
 *   node .claude/skills/bugfix/scripts/bugfix-debug-log.cjs start --tag a4f2
 *   node .claude/skills/bugfix/scripts/bugfix-debug-log.cjs stop --tag a4f2
 *   node .claude/skills/bugfix/scripts/bugfix-debug-log.cjs status --tag a4f2
 *   node .claude/skills/bugfix/scripts/bugfix-debug-log.cjs --self-test
 *   node .claude/skills/bugfix/scripts/bugfix-debug-log.cjs --help
 * (fallback: ~/.claude/skills/bugfix/scripts/bugfix-debug-log.cjs)
 */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_PORT = 7399;
const MAX_BODY = 64 * 1024;
const TAG_RE = /^[a-f0-9]{4}$/i;

/**
 * @param {string[]} argv
 * @returns {{ positional: string[], flags: Record<string, string | boolean> }}
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

const USAGE = `Usage: bugfix-debug-log.cjs <start|stop|status> --tag <4 hex chars> [--port N] [root]
       bugfix-debug-log.cjs --self-test
       bugfix-debug-log.cjs --help

Local debug-log ingest. Listens on 127.0.0.1 (default port ${DEFAULT_PORT}) and appends
NDJSON to <root>/.harness/debug-<tag>.log. Root defaults to the current directory.`;

/**
 * @param {string} consumerRoot
 * @param {string} tag
 */
function pathsFor(consumerRoot, tag) {
	const dir = path.join(consumerRoot, '.harness');
	return {
		dir,
		log: path.join(dir, `debug-${tag}.log`),
		pid: path.join(dir, `debug-${tag}.pid`),
		url: path.join(dir, `debug-${tag}.url`),
	};
}

/**
 * @param {unknown} flags
 * @returns {string}
 */
function requireTag(flags) {
	const raw = typeof flags.tag === 'string' ? flags.tag.trim().toLowerCase() : '';
	if (!TAG_RE.test(raw)) {
		console.error('bugfix-debug-log: --tag must be 4 hex chars (example: a4f2)');
		process.exit(1);
	}
	return raw;
}

/**
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {string} [body]
 * @param {Record<string, string>} [extra]
 */
function send(res, status, body = '', extra = {}) {
	res.writeHead(status, {
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type',
		...extra,
	});
	res.end(body);
}

/**
 * @param {string} logPath
 * @param {unknown} payload
 */
function appendLine(logPath, payload) {
	const row =
		payload && typeof payload === 'object' && !Array.isArray(payload)
			? { t: new Date().toISOString(), ...payload }
			: { t: new Date().toISOString(), data: payload };
	fs.appendFileSync(logPath, `${JSON.stringify(row)}\n`, 'utf8');
}

/**
 * @param {string} consumerRoot
 * @param {string} tag
 * @param {number} port
 */
function startServer(consumerRoot, tag, port) {
	const files = pathsFor(consumerRoot, tag);
	fs.mkdirSync(files.dir, { recursive: true });

	if (fs.existsSync(files.pid)) {
		const oldPid = Number(fs.readFileSync(files.pid, 'utf8').trim());
		if (oldPid && !Number.isNaN(oldPid)) {
			try {
				process.kill(oldPid, 0);
				console.error(
					`bugfix-debug-log: already running pid ${oldPid} (stop --tag ${tag} first)`,
				);
				process.exit(1);
			} catch {
				fs.unlinkSync(files.pid);
			}
		}
	}

	fs.writeFileSync(files.log, '', 'utf8');

	const server = http.createServer((req, res) => {
		if (req.method === 'OPTIONS') {
			send(res, 204);
			return;
		}

		if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
			const lines = fs.existsSync(files.log)
				? fs.readFileSync(files.log, 'utf8').split('\n').filter(Boolean).length
				: 0;
			send(res, 200, JSON.stringify({ ok: true, log: files.log, lines }), {
				'Content-Type': 'application/json',
			});
			return;
		}

		if (req.method !== 'POST') {
			send(res, 405, 'POST JSON to /');
			return;
		}

		/** @type {Buffer[]} */
		const chunks = [];
		let size = 0;
		req.on('data', (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY) {
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => {
			try {
				const raw = Buffer.concat(chunks).toString('utf8');
				const payload = raw ? JSON.parse(raw) : {};
				appendLine(files.log, payload);
				send(res, 204);
			} catch {
				send(res, 400, 'invalid JSON');
			}
		});
	});

	server.on('error', (err) => {
		console.error(`bugfix-debug-log: ${err.message}`);
		process.exit(1);
	});

	server.listen(port, '127.0.0.1', () => {
		const addr = server.address();
		const bound = typeof addr === 'object' && addr ? addr.port : port;
		const url = `http://127.0.0.1:${bound}/`;
		fs.writeFileSync(files.pid, String(process.pid), 'utf8');
		fs.writeFileSync(files.url, url, 'utf8');
		console.log(`bugfix-debug-log: url=${url}`);
		console.log(`bugfix-debug-log: log=${files.log}`);
		console.log(`bugfix-debug-log: tag=${tag}`);
	});

	const shutdown = () => {
		try {
			if (fs.existsSync(files.pid)) {
				fs.unlinkSync(files.pid);
			}
		} catch {
			/* ignore */
		}
		server.close(() => process.exit(0));
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
}

function stopServer(consumerRoot, tag) {
	const files = pathsFor(consumerRoot, tag);
	if (!fs.existsSync(files.pid)) {
		console.log(`bugfix-debug-log: not running (no pid for ${tag})`);
		return;
	}
	const pid = Number(fs.readFileSync(files.pid, 'utf8').trim());
	if (pid && !Number.isNaN(pid)) {
		try {
			process.kill(pid, 'SIGTERM');
		} catch (err) {
			const e = /** @type {NodeJS.ErrnoException} */ (err);
			if (e.code !== 'ESRCH') {
				throw err;
			}
		}
	}
	try {
		fs.unlinkSync(files.pid);
	} catch {
		/* ignore */
	}
	console.log(`bugfix-debug-log: stopped tag=${tag}`);
}

function status(consumerRoot, tag) {
	const files = pathsFor(consumerRoot, tag);
	const running = (() => {
		if (!fs.existsSync(files.pid)) {
			return false;
		}
		const pid = Number(fs.readFileSync(files.pid, 'utf8').trim());
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	})();
	const lines = fs.existsSync(files.log)
		? fs.readFileSync(files.log, 'utf8').split('\n').filter(Boolean).length
		: 0;
	const url = fs.existsSync(files.url) ? fs.readFileSync(files.url, 'utf8').trim() : '';
	console.log(
		JSON.stringify({
			tag,
			running,
			log: files.log,
			url,
			lines,
		}),
	);
}

function selfTest() {
	const { spawn, execFileSync } = require('node:child_process');
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bugfix-debug-self-test-'));
	const tag = 'a4f2';
	const port = 17432;
	const child = spawn(
		process.execPath,
		[__filename, 'start', '--tag', tag, '--port', String(port), root],
		{ stdio: ['ignore', 'pipe', 'pipe'] },
	);

	const ready = new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('start timeout')), 8000);
		child.stdout.on('data', (buf) => {
			if (String(buf).includes('url=')) {
				clearTimeout(timer);
				resolve(undefined);
			}
		});
		child.stderr.on('data', (buf) => {
			reject(new Error(String(buf)));
		});
		child.on('exit', (code) => {
			if (code && code !== 0) {
				reject(new Error(`start exited ${code}`));
			}
		});
	});

	return ready
		.then(
			() =>
				new Promise((resolve, reject) => {
					const req = http.request(
						{
							hostname: '127.0.0.1',
							port,
							path: '/',
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
						},
						(res) => {
							res.resume();
							res.on('end', () => {
								if (res.statusCode === 204) {
									resolve(undefined);
								} else {
									reject(new Error(`POST status ${res.statusCode}`));
								}
							});
						},
					);
					req.on('error', reject);
					req.end(JSON.stringify({ h: 'H1', loc: 'self-test' }));
				}),
		)
		.then(() => {
			execFileSync(process.execPath, [__filename, 'stop', '--tag', tag, root], {
				stdio: 'pipe',
			});
			const logPath = pathsFor(root, tag).log;
			const text = fs.readFileSync(logPath, 'utf8');
			if (!text.includes('"h":"H1"') || !text.includes('self-test')) {
				throw new Error(`unexpected log: ${text}`);
			}
			fs.rmSync(root, { recursive: true, force: true });
			console.log('bugfix-debug-log: self-test OK');
		})
		.catch((err) => {
			try {
				child.kill('SIGTERM');
			} catch {
				/* ignore */
			}
			fs.rmSync(root, { recursive: true, force: true });
			console.error(`bugfix-debug-log: self-test failed: ${err.message}`);
			process.exit(1);
		});
}

function main() {
	const { positional, flags } = parseArgs(process.argv.slice(2));
	if (flags.help === true || flags.h === true || positional[0] === 'help') {
		console.log(USAGE);
		return;
	}
	if (flags['self-test'] === true || positional[0] === '--self-test') {
		return selfTest();
	}

	const cmd = positional[0] ?? 'start';
	const rootArg = positional[1];
	const consumerRoot = resolveConsumerRoot(
		typeof rootArg === 'string' ? rootArg : undefined,
	);

	if (cmd === 'start') {
		const tag = requireTag(flags);
		const portRaw = flags.port;
		const port =
			typeof portRaw === 'string' && portRaw ? Number(portRaw) : DEFAULT_PORT;
		if (!Number.isInteger(port) || port < 0) {
			console.error('bugfix-debug-log: --port must be an integer');
			process.exit(1);
		}
		startServer(consumerRoot, tag, port);
		return;
	}

	if (cmd === 'stop') {
		stopServer(consumerRoot, requireTag(flags));
		return;
	}

	if (cmd === 'status') {
		status(consumerRoot, requireTag(flags));
		return;
	}

	console.error('bugfix-debug-log: command must be start | stop | status');
	process.exit(1);
}

main();
