import type { MaskedLine } from './mask.ts';

/**
 * The Python equivalent of `mask.ts`.
 *
 * Python needs its own implementation rather than a flag on the JavaScript one, because three of
 * its constructs have no JS analogue and each produces false evidence if ignored:
 *
 *  - **Docstrings.** A triple-quoted string is Python's documentation, and prose describing a
 *    feature is not the feature. Scanning a fixture produced a finding whose cited line was
 *    `"""Create a session token."""` -- the docstring, not the token code.
 *  - **`#` comments**, which JavaScript masking treats as live code.
 *  - **f-strings.** The literal parts are data, but `{...}` holds real expressions, so blanking the
 *    whole thing would hide a genuine `f"... {user_input}"` interpolation -- which is exactly the
 *    SQL-injection signal we most want to keep.
 *
 * Both views preserve line length, so column positions stay meaningful.
 */

const blank = (n: number) => ' '.repeat(Math.max(0, n));

interface PyState {
  /** The delimiter of a triple-quoted string opened on an earlier line, if any. */
  openTriple?: '"""' | "'''";
}

/** Prefixes a Python string literal can carry: r, b, u, f, rb, fr, and so on. */
const STRING_PREFIX = /[rRbBuUfF]{0,2}$/;

function isFString(line: string, quoteStart: number): boolean {
  // Look back over the prefix characters immediately before the quote.
  let i = quoteStart - 1;
  let prefix = '';
  while (i >= 0 && /[rRbBuUfF]/.test(line[i] as string)) {
    prefix = (line[i] as string) + prefix;
    i--;
  }
  return /[fF]/.test(prefix);
}

/**
 * Mask an f-string body: blank the literal text but keep whatever is inside `{...}`.
 *
 * This is the one place where a string's contents are partly code. `f"SELECT * WHERE id={uid}"`
 * must keep `uid` visible so the interpolation is detectable, while the SQL text itself stays
 * available to the `code` view for the literal-matching signals.
 */
function maskFStringBody(body: string): string {
  let out = '';
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i] as string;
    // `{{` and `}}` are escaped braces, not an expression.
    if (ch === '{' && body[i + 1] === '{') {
      out += '  ';
      i++;
      continue;
    }
    if (ch === '}' && body[i + 1] === '}') {
      out += '  ';
      i++;
      continue;
    }
    if (ch === '{') {
      depth++;
      out += ch;
      continue;
    }
    if (ch === '}') {
      depth = Math.max(0, depth - 1);
      out += ch;
      continue;
    }
    out += depth > 0 ? ch : ' ';
  }
  return out;
}

function tripleAt(line: string, i: number): '"""' | "'''" | undefined {
  if (line.startsWith('"""', i)) return '"""';
  if (line.startsWith("'''", i)) return "'''";
  return undefined;
}

function maskOne(line: string, state: PyState): MaskedLine {
  const n = line.length;
  let code = '';
  let masked = '';
  let i = 0;

  // --- continuation of a triple-quoted string from a previous line ---
  if (state.openTriple) {
    const close = line.indexOf(state.openTriple);
    if (close === -1) {
      // Entire line is inside a docstring or multi-line literal: never evidence.
      return { code: blank(n), masked: blank(n) };
    }
    const end = close + 3;
    code += blank(end);
    masked += blank(end);
    i = end;
    state.openTriple = undefined;
  }

  while (i < n) {
    const ch = line[i] as string;

    if (ch === '#') {
      code += blank(n - i);
      masked += blank(n - i);
      break;
    }

    const triple = tripleAt(line, i);
    if (triple) {
      const close = line.indexOf(triple, i + 3);
      if (close === -1) {
        state.openTriple = triple;
        code += blank(n - i);
        masked += blank(n - i);
        break;
      }
      const end = close + 3;
      // A docstring is prose in both views: it describes code rather than being code.
      code += blank(end - i);
      masked += blank(end - i);
      i = end;
      continue;
    }

    if (ch === '"' || ch === "'") {
      const fstring = isFString(line, i);
      let j = i + 1;
      while (j < n) {
        const c = line[j];
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (c === ch) break;
        j++;
      }
      if (j >= n) {
        // Unterminated: treat the remainder as data.
        code += line.slice(i);
        masked += ch + blank(n - i - 1);
        break;
      }
      const body = line.slice(i + 1, j);
      code += line.slice(i, j + 1);
      masked += ch + (fstring ? maskFStringBody(body) : blank(body.length)) + ch;
      i = j + 1;
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

/** Mask a whole Python file, carrying triple-quote state across lines. */
export function maskPythonFile(lines: readonly string[]): MaskedLine[] {
  const state: PyState = {};
  return lines.map((line) => maskOne(line, state));
}

/** Single-line convenience wrapper. Cannot see multi-line docstrings, by definition. */
export function maskPythonLine(line: string): MaskedLine {
  return maskOne(line, {});
}

export { STRING_PREFIX };
