// Single source of truth for whether ANSI color should be emitted.
//
// Reality check: ANSI SGR color only renders in a real terminal. Claude Code's chat
// is a markdown surface — when an agent relays a command's output it lands in a code
// block, where escape codes are stripped (plain) or shown literally (garbage), never
// as color. So we use the standard, safe policy instead of forcing color on:
//   • OFF on NO_COLOR (any value) or an explicit --no-color flag   (opt-out)
//   • OFF on TERM=dumb                                             (no capabilities)
//   • ON  on FORCE_COLOR                                           (force, for an
//        ANSI-capable pager/pipe — or to test whether your UI renders it)
//   • otherwise ON only when the target stream is a real TTY
// Net: color in your own terminal, clean plain text in the Claude relay / pipes / files
// (so no escape-code garbage), and a FORCE_COLOR escape hatch.
export function colorEnabled(noColorFlag = false, stream = process.stdout) {
  if (process.env.NO_COLOR || noColorFlag) return false;
  if (process.env.FORCE_COLOR) return true;
  if (process.env.TERM === 'dumb') return false;
  return !!(stream && stream.isTTY);
}
