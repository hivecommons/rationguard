/**
 * Strips terminal control characters (C0 + DEL + C1, including ESC/CSI/OSC
 * sequences) from untrusted text before it is printed to the operator's
 * terminal. Plain newlines and tabs are preserved for readability; everything
 * else in the C0/C1 ranges is collapsed to a single space so multi-escape
 * payloads can't be reassembled by whitespace stripping alone.
 *
 * This must only be applied to the untrusted value being interpolated —
 * never to the rationguard-owned ANSI color codes wrapped around it.
 */
export function sanitizeForTerminal(text: string): string {
  return text
    // OSC (Operating System Command) sequences, e.g. window-title spoofing
    // or OSC 52 clipboard writes: ESC ] ... terminated by BEL or ST (ESC \).
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, ' ')
    // CSI (Control Sequence Introducer) sequences, e.g. cursor movement,
    // screen clear/overwrite: ESC [ ... followed by a final byte in @-~.
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ' ')
    // Any other two-byte ESC sequences (e.g. ESC c full reset).
    .replace(/\x1b[@-Z\\-_]/g, ' ')
    // Remaining raw C0 control chars (except \t and \n), DEL, and C1 range —
    // covers any stray/incomplete escape bytes not matched above.
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}
