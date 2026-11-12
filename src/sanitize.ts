// Replaces `intro` ... BEL/ST strings in a single pass. A lazy `[\s\S]*?`
// regex rescans to end-of-input for every unterminated introducer (quadratic);
// once one search finds no terminator, no later introducer can have one.
// Unterminated introducers are left in place, like the regex form did.
function replaceControlStrings(text: string, intro: RegExp, replacement: string): string {
  const introducer = new RegExp(intro.source, 'g');
  const terminator = /\x07|\x9c|\x1b\\/g;
  let out = '';
  let pos = 0;
  for (;;) {
    introducer.lastIndex = pos;
    const start = introducer.exec(text);
    if (!start) break;
    terminator.lastIndex = start.index + start[0].length;
    const end = terminator.exec(text);
    if (!end) break;
    out += text.slice(pos, start.index) + replacement;
    pos = end.index + end[0].length;
  }
  return out + text.slice(pos);
}

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
 * movement, screen clear/overwrite), and DCS, SOS, PM and APC control strings,
 * including their 7-bit ESC and 8-bit C1 forms. Control strings end at BEL,
 * ST or 8-bit ST. Also covers charset-designation and
 * keypad-mode two-byte ESC forms, nF sequences with intermediate bytes (e.g.
 * ESC # 8, ESC % G, ESC SP F), any other two-byte ESC sequence (e.g.
 * ESC c full reset), and the raw C0/DEL/C1 control-character ranges (with
 * `\t` and `\n` left untouched by the caller, since this helper only removes
 * escape junk, not plain whitespace). Unicode bidi override/embedding/isolate
 * controls are removed too: they visually reorder the rest of the line,
 * including the provenance tag (Trojan Source class, CVE-2021-42574).
 *
 * `replacement` defaults to a single space so multi-escape payloads can't be
 * reassembled by later whitespace collapsing; pass `''` if the caller wants
 * sequences removed with no trace.
 */
export function stripTerminalEscapes(text: string, replacement = ' '): string {
  // Consume all control strings together so their terminators retain input order.
  const withoutStrings = replaceControlStrings(text, /\x1b[\]P_^X]|[\x90\x98\x9d\x9e\x9f]/, replacement);
  return withoutStrings
    // CSI accepts both the ESC [ and C1 forms.
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, replacement)
    // Charset designation, e.g. ESC ( B.
    .replace(/\x1b[()][A-Z0-9]/g, replacement)
    // Keypad mode (application/numeric), e.g. ESC = / ESC >.
    .replace(/\x1b[=>]/g, replacement)
    // nF sequences: ESC + one or more intermediates (0x20–0x2F) + final (0x30–0x7E), e.g. ESC # 8.
    .replace(/\x1b[ -/]+[0-~]/g, replacement)
    // Any other two-byte ESC sequence not matched above (Fp/Fe/Fs finals 0x30–0x7E).
    .replace(/\x1b[0-~]/g, replacement)
    // Remaining raw C0 control chars (except \t and \n), DEL, and C1 range —
    // covers any stray/incomplete escape bytes not matched above.
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]+/g, replacement)
    // Bidi embedding/override (U+202A–U+202E) and isolate (U+2066–U+2069) controls.
    .replace(/[\u202A-\u202E\u2066-\u2069]+/g, replacement);
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
 * mode. Bidi embedding, override and isolate controls can also reorder
 * visible output, including provenance, if emitted raw.
 * Untrusted values (project-local excuse text, matched agent
 * output, pluk session metadata) would otherwise bypass the print-safety
 * boundary `sanitizeForTerminal` enforces on the plain-text path.
 *
 * Those code points are rewritten as `\uXXXX` escapes, so the output is
 * byte-for-byte terminal-safe while remaining valid JSON that parses to
 * exactly the same value — no data is dropped, unlike `sanitizeForTerminal`.
 */
export function stringifyForTerminal(value: unknown, indent?: number): string {
  return JSON.stringify(value, null, indent).replace(
    /[\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g,
    c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
// A cluster occupies two cells when it is presented as emoji (an
// Emoji_Presentation code point, a VS16 request, or a regional-indicator flag)
// or starts with an East Asian Wide/Fullwidth code point (CJK, Hangul, kana,
// fullwidth forms).
const WIDE_EMOJI = /\p{Emoji_Presentation}|\uFE0F|\p{Regional_Indicator}/u;
const WIDE_EAST_ASIAN =
  /^[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6\u{16FE0}-\u{16FE4}\u{17000}-\u{18AFF}\u{1B000}-\u{1B2FF}\u{20000}-\u{2FFFD}\u{30000}-\u{3FFFD}]/u;
// Clusters made only of combining marks or format characters (ZWJ, ZWSP,
// directional marks) take no cell of their own.
const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}]+$/u;

/**
 * Number of terminal cells `text` occupies, counted per grapheme cluster:
 * 2 for wide (CJK/fullwidth) and emoji clusters, 0 for clusters made only of
 * combining marks or format characters, 1 otherwise. `String#length` counts
 * UTF-16 code units instead, which over-counts astral and combined characters
 * and under-counts wide ones. Expects text already passed through
 * `sanitizeForTerminal`.
 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const { segment } of graphemes.segment(text)) {
    if (WIDE_EMOJI.test(segment) || WIDE_EAST_ASIAN.test(segment)) width += 2;
    else if (!ZERO_WIDTH.test(segment)) width += 1;
  }
  return width;
}

/** `String#padEnd` by terminal cells (see `displayWidth`) instead of UTF-16 code units. */
export function padEndDisplay(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}
