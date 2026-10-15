# Semgrep rules: WordPress plugin

Small, high-signal rules used by `security-assess.cjs` for **whole-plugin** health. The per-change scan is `security-audit.cjs`, which does not use these.

- Prefer local rules over fragile community packs.
- Avoid Semgrep `join` mode (may require login).
- Extra configs: pass `--semgrep-config a,b` to `security-assess.cjs` (`p/php` is already requested by the script when available).

Install Semgrep: `pipx install semgrep` or `brew install semgrep`.
