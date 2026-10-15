# Instrumentation

## Debug log (required)

Same idea as Cursor Debug Mode: probes ship JSON to a local ingest; the agent reads **one file**.

1. Pick a tag: 4 hex chars (example `a4f2`).
2. Start ingest from the **repo root** (background it; it stays up until `stop`):

```bash
node .claude/skills/bugfix/scripts/bugfix-debug-log.cjs start --tag a4f2
```

If the skill is installed globally, use `~/.claude/skills/bugfix/scripts/bugfix-debug-log.cjs` instead.

Writes `.harness/debug-a4f2.log` (NDJSON). Default URL: `http://127.0.0.1:7399/`.
3. After the repro, **Read that log file**. Do not rely on scrolling the terminal.
4. `node .claude/skills/bugfix/scripts/bugfix-debug-log.cjs stop --tag a4f2` in cleanup (and delete `.harness/debug-a4f2.log` / `.url` / `.pid` if they remain).

## What to log

Only probes that distinguish hypotheses: branch taken, boundary values (ids, flags, status), call order / timing.

Not: whole objects, secrets, tokens, PII, credentialed bodies.

## Probe shape

POST JSON to the ingest. `h` = hypothesis id. `loc` = file + symbol. Extra fields are the prediction.

```js
fetch('http://127.0.0.1:7399/', {
	method: 'POST',
	headers: { 'Content-Type': 'application/json' },
	body: JSON.stringify({ h: 'H2', loc: 'CartTotals.tsx:calcTax', tax: null }),
}).catch(() => {});
```

PHP (non-blocking). If HTTP cannot reach 127.0.0.1 from PHP, append the same JSON line to the log file instead:

```php
wp_remote_post( 'http://127.0.0.1:7399/', array(
	'blocking' => false,
	'timeout'  => 0.01,
	'headers'  => array( 'Content-Type' => 'application/json' ),
	'body'     => wp_json_encode( array( 'h' => 'H2', 'loc' => __FUNCTION__, 'id' => $id ) ),
) );
```

Keep `[BUGFIX-a4f2]` in a `console`/`error_log` **only as backup**. The NDJSON file is the evidence.

## Where

Likely-affected files from the symptom. Prefer public boundaries. Instrument all ranked hypotheses in one round so one repro can kill several.

## Reproduce

Run the same path twice when the bug is timing-related. Prefer a command the repo already has.

Empty log after a good repro → probes are on the wrong path, not “hypothesis disproved.” Move the probes; do not invent a fix.

## Cleanup (required)

After apply + verified repro (or skip):

1. `stop --tag <tag>`
2. `rg 'BUGFIX-<tag>|127.0.0.1:7399|debug-<tag>'` — remove every probe
3. Delete `.harness/debug-<tag>.log` / `.pid` / `.url` and any throwaway harness
4. Re-run the repro once **without** probes
