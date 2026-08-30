/**
 * Separate a source line into what is *code* and what is *data*, so a pattern that means
 * "this project calls X" cannot be satisfied by X merely being mentioned.
 *
 * CodeIsotope found this bug in itself, three times over:
 *
 *  - `src/gaps/catalog.ts` lists `'AbortSignal.timeout (built-in)'` as a known solution, and the
 *    timeout signal matched that string -- so the tool reported its own catalog as proof that
 *    outbound timeouts were handled.
 *  - A JSDoc line in `src/vet/github.ts` mentioning "the local `gh` CLI login" matched the auth
 *    vocabulary, making a keyless tool look like it handles credentials.
 *  - The `HELP` template literal in `src/cli.ts` contains the words "rate limit", which satisfied
 *    the rate-limiting signal from inside a string spanning 30 lines.
 *
 * None of these is really about self-reference. Any project with a table of package names, a set
 * of lint rules, or a fixture of example payloads produces exactly the same false evidence.
 *
 * Two outputs per line, because the two questions are different:
 *
 *  - `code`   -- comments and multi-line string bodies blanked; single-line string literals kept.
 *                For signals where the string *is* the evidence: `process.on('SIGTERM')`,
 *                a route path, a SQL statement.
 *  - `masked` -- as above, and single-line string and regex bodies blanked too. For signals that
 *                mean "this code calls X".
 *
 * Both preserve line length, so column positions stay meaningful.
 */

export interface MaskedLine {
  /** Comments and multi-line string bodies removed. */
  code: string;
  /** As `code`, plus the contents of string and regex literals removed. */
  masked: string;
}

interface CarryState {
  inBlockComment: boolean;
  /** Inside a template literal that opened on an earlier line. */
  inTemplate: boolean;
}

const blank = (n: number) => ' '.repeat(Math.max(0, n));

/**
 * Mask a whole file, carrying block-comment and template-literal state across lines.
 * Line-at-a-time masking cannot do this, and both cases leak in practice.
 */
export function maskFileLines(lines: readonly string[]): MaskedLine[] {
  const state: CarryState = { inBlockComment: false, inTemplate: false };
  return lines.map((line) => maskOne(line, state));
}

/** Single-line convenience wrapper. Cannot see multi-line constructs, by definition. */
export function maskLiterals(line: string): string {
  return maskOne(line, { inBlockComment: false, inTemplate: false }).masked;
}

/** Single-line wrapper returning both forms. */
export function maskLine(line: string): MaskedLine {
  return maskOne(line, { inBlockComment: false, inTemplate: false });
}

function maskOne(line: string, state: CarryState): MaskedLine {
  const n = line.length;
  let code = '';
  let masked = '';
  let i = 0;

  // --- continuations from previous lines ---

  if (state.inBlockComment) {
    const end = line.indexOf('*/');
    if (end === -1) {
      return { code: blank(n), masked: blank(n) };
    }
    state.inBlockComment = false;
    code += blank(end + 2);
    masked += blank(end + 2);
    i = end + 2;
  } else if (state.inTemplate) {
    // A line in the middle of a multi-line template is data in both forms.
    const close = findUnescaped(line, 0, '`');
    if (close === -1) {
      return { code: blank(n), masked: blank(n) };
    }
    state.inTemplate = false;
    code += blank(close + 1);
    masked += blank(close + 1);
    i = close + 1;
  }

  // --- the rest of the line ---

  while (i < n) {
    const ch = line[i] as string;

    if (ch === '/' && line[i + 1] === '/') {
      code += blank(n - i);
      masked += blank(n - i);
      break;
    }

    if (ch === '/' && line[i + 1] === '*') {
      const end = line.indexOf('*/', i + 2);
      if (end === -1) {
        state.inBlockComment = true;
        code += blank(n - i);
        masked += blank(n - i);
        break;
      }
      code += blank(end + 2 - i);
      masked += blank(end + 2 - i);
      i = end + 2;
      continue;
    }

    if (ch === '`') {
      const close = findUnescaped(line, i + 1, '`');
      if (close === -1) {
        // Opens a multi-line template: body is data from here on.
        state.inTemplate = true;
        code += blank(n - i);
        masked += blank(n - i);
        break;
      }
      const body = close - i - 1;
      code += line.slice(i, close + 1);
      masked += '`' + blank(body) + '`';
      i = close + 1;
      continue;
    }

    if (ch === '"' || ch === "'") {
      const close = findUnescaped(line, i + 1, ch);
      if (close === -1) {
        code += line.slice(i);
        masked += ch + blank(n - i - 1);
        break;
      }
      const body = close - i - 1;
      code += line.slice(i, close + 1);
      masked += ch + blank(body) + ch;
      i = close + 1;
      continue;
    }

    // A regex literal, told apart from division by what precedes it.
    if (ch === '/' && opensRegex(code)) {
      const end = regexEnd(line, i);
      if (end === -1) {
        code += line.slice(i);
        masked += blank(n - i);
        break;
      }
      code += line.slice(i, end);
      masked += '/' + blank(end - i - 2) + '/';
      i = end;
      continue;
    }

    code += ch;
    masked += ch;
    i++;
  }

  return {
    code: code.length < n ? code + blank(n - code.length) : code,
    masked: masked.length < n ? masked + blank(n - masked.length) : masked,
  };
}

/** Index of the next unescaped occurrence of `quote`, or -1. */
function findUnescaped(line: string, from: number, quote: string): number {
  for (let i = from; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === quote) return i;
  }
  return -1;
}

/** Index one past the end of a regex literal (including flags), or -1 if unterminated. */
function regexEnd(line: string, start: number): number {
  let i = start + 1;
  let inClass = false;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) {
      let end = i + 1;
      while (end < line.length && /[dgimsuvy]/.test(line[end] as string)) end++;
      return end;
    }
    i++;
  }
  return -1;
}

/** True when a `/` at this point starts a pattern rather than a division. */
function opensRegex(before: string): boolean {
  const trimmed = before.trimEnd();
  if (trimmed.length === 0) return true;
  const last = trimmed[trimmed.length - 1] as string;
  if (/[\w$)\]]/.test(last)) {
    // ...unless it follows a keyword: `return /x/.test(s)`, `case /x/`.
    return /\b(return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await)$/.test(trimmed);
  }
  return true;
}
