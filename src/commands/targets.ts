import { BRIEF_BODY, BRIEF_DESCRIPTION } from '../templates/brief.ts';
import { TOOL_VERSION } from '../lib/version.ts';

/** Lets us recognise our own generated file and update it without --force. */
export const MARKER = 'reporadar:generated';

export interface Target {
  key: string;
  label: string;
  /** Presence of this directory means the developer uses this CLI. */
  detectDir: string;
  /** Where the slash command lives, relative to the project root. */
  file: string;
  /** Each CLI's own placeholder for user-supplied arguments. */
  argsToken: string;
  render: (body: string) => string;
}

function yamlFrontmatter(fields: Record<string, string>, body: string): string {
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join('\n')}\n---\n\n<!-- ${MARKER} v${TOOL_VERSION} -- regenerate with: npx reporadar init --force -->\n\n${body}\n`;
}

/**
 * TOML multi-line *literal* strings ('''...''') process no escape sequences at all, so the prompt
 * body -- full of backticks, $ tokens and Markdown -- survives verbatim. The only sequence that
 * could terminate the string early is a triple quote, so that is the only thing we guard against.
 */
function tomlLiteral(text: string): string {
  return text.replaceAll("'''", "' ' '");
}

export const TARGETS: Target[] = [
  {
    key: 'claude',
    label: 'Claude Code',
    detectDir: '.claude',
    file: '.claude/commands/reporadar.md',
    argsToken: '$ARGUMENTS',
    render: (body) =>
      yamlFrontmatter(
        {
          description: BRIEF_DESCRIPTION,
          'allowed-tools': 'Bash(npx --yes reporadar:*), Bash(reporadar:*), Read, Grep, Glob',
        },
        body,
      ),
  },
  {
    key: 'opencode',
    label: 'opencode',
    detectDir: '.opencode',
    file: '.opencode/commands/reporadar.md',
    argsToken: '$ARGUMENTS',
    render: (body) => yamlFrontmatter({ description: BRIEF_DESCRIPTION }, body),
  },
  {
    key: 'cursor',
    label: 'Cursor',
    detectDir: '.cursor',
    file: '.cursor/commands/reporadar.md',
    argsToken: '$ARGUMENTS',
    render: (body) => `# ${BRIEF_DESCRIPTION}\n\n<!-- ${MARKER} v${TOOL_VERSION} -->\n\n${body}\n`,
  },
  {
    key: 'gemini',
    label: 'Gemini CLI',
    detectDir: '.gemini',
    file: '.gemini/commands/reporadar.toml',
    argsToken: '{{args}}',
    render: (body) =>
      `# ${MARKER} v${TOOL_VERSION}
description = "${BRIEF_DESCRIPTION}"
prompt = '''
${tomlLiteral(body)}
'''
`,
  },
  {
    key: 'windsurf',
    label: 'Windsurf',
    detectDir: '.windsurf',
    file: '.windsurf/workflows/reporadar.md',
    argsToken: '$ARGUMENTS',
    render: (body) => yamlFrontmatter({ description: BRIEF_DESCRIPTION }, body),
  },
  {
    key: 'copilot',
    label: 'GitHub Copilot',
    detectDir: '.github',
    file: '.github/prompts/reporadar.prompt.md',
    argsToken: '${input:focus}',
    render: (body) => yamlFrontmatter({ mode: 'agent', description: BRIEF_DESCRIPTION }, body),
  },
];

/** Fill in the CLI-specific argument placeholder and render the final file contents. */
export function renderFor(target: Target): string {
  return target.render(BRIEF_BODY.replaceAll('{{ARGS}}', target.argsToken));
}

export function targetByKey(key: string): Target | undefined {
  return TARGETS.find((t) => t.key === key.toLowerCase());
}
