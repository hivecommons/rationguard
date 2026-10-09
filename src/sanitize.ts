/**
 * Low-level "strip terminal escape sequences" helper shared by every place
 * in this codebase that needs to remove escape/control junk from untrusted
 * text — currently `sanitizeForTerminal` below (the print-safety boundary
 * for text shown to the operator) and `watcher.ts`'s buffered raw-pane
 * cleanup (input to pattern matching). Both trust boundaries need the same
 * underlying set of sequences recognized; if you discover a new escape
 * sequence that needs blocking, add it here once rather than forking a new
 * regex chain at the call site.
 *
 * Covers OSC (window-title spoofing, OSC 52 clipboard writes), CSI (cursor
 * movement, screen clear/overwrite), DCS, charset-designation and
 * keypad-mode two-byte ESC forms, any other two-byte ESC sequence (e.g.
 * ESC c full reset), and the raw C0/DEL/C1 control-character ranges (with
 * `\t` and `\n` left untouched by the caller, since this helper only removes
 * escape junk, not plain whitespace).
 *
 * `replacement` defaults to a single space so multi-escape payloads can't be
 * reassembled by later whitespace collapsing; pass `''` if the caller wants
 * sequences removed with no trace.
 */
export function stripTerminalEscapes(text: string, replacement = ' '): string {
  return text
    // OSC (Operating System Command): ESC ] ... terminated by BEL or ST (ESC \).
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, replacement)
    // CSI (Control Sequence Introducer): ESC [ ... followed by a final byte in @-~.
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, replacement)
    // DCS (Device Control String): ESC P ... terminated by ST (ESC \).
    .replace(/\x1bP[^\x1b]*\x1b\\/g, replacement)
    // Charset designation, e.g. ESC ( B.
    .replace(/\x1b[()][A-Z0-9]/g, replacement)
    // Keypad mode (application/numeric), e.g. ESC = / ESC >.
    .replace(/\x1b[=>]/g, replacement)
    // Any other two-byte ESC sequence not matched above.
    .replace(/\x1b[@-Z\\-_]/g, replacement)
    // Remaining raw C0 control chars (except \t and \n), DEL, and C1 range —
    // covers any stray/incomplete escape bytes not matched above.
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]+/g, replacement);
}

/**
 * Strips terminal control characters (C0 + DEL + C1, including ESC/CSI/OSC
 * sequences) from untrusted text before it is printed to the operator's
 * terminal. Plain newlines and tabs are preserved for readability; everything
 * else in the C0/C1 ranges is collapsed to a single space so multi-escape
 * payloads can't be reassembled by whitespace stripping alone.
 *
 * This must only be applied to the untrusted value being interpolated —
 * never to the rationguard-owned ANSI color codes wrapped around it.
 *
 * Builds on the shared `stripTerminalEscapes` helper by additionally
 * collapsing runs of stripped/whitespace characters to a single space and
 * trimming — print-safety guarantees that watcher.ts's matcher-input
 * cleanup doesn't need.
 */
export function sanitizeForTerminal(text: string): string {
  return stripTerminalEscapes(text, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/**
 * `JSON.stringify` for `--json` output that still ends up on a terminal
 * (directly, or via `jq`). The JSON grammar only requires escaping U+0000–
 * U+001F, so V8 emits DEL (U+007F) and the C1 range (U+0080–U+009F) as raw
 * code points — and U+009B/U+009D/U+0090 are the 8-bit CSI/OSC/DCS
 * introducers that xterm, VTE and other emulators honour even in UTF-8
 * mode. Untrusted values (project-local excuse text, matched agent
 * output, pluk session metadata) would otherwise bypass the print-safety
 * boundary `sanitizeForTerminal` enforces on the plain-text path.
 *
 * Those code points are rewritten as `\uXXXX` escapes, so the output is
 * byte-for-byte terminal-safe while remaining valid JSON that parses to
 * exactly the same value — no data is dropped, unlike `sanitizeForTerminal`.
 */
export function stringifyForTerminal(value: unknown, indent?: number): string {
  return JSON.stringify(value, null, indent).replace(
    /[\x7f-\x9f]/g,
    c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}
