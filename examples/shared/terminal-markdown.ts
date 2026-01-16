type AnsiStyle = {
  reset: string;
  bold: string;
  italic: string;
  underline: string;
  dim: string;
  code: string;
};

function createAnsi(enabled: boolean): AnsiStyle {
  if (!enabled) {
    return {
      reset: '',
      bold: '',
      italic: '',
      underline: '',
      dim: '',
      code: '',
    };
  }
  return {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    italic: '\x1b[3m',
    underline: '\x1b[4m',
    dim: '\x1b[2m',
    code: '\x1b[36m',
  };
}

export class MarkdownStreamRenderer {
  private buffer = '';
  private inCodeBlock = false;
  private fence = '```';
  private readonly ansi: AnsiStyle;

  constructor(private readonly output: NodeJS.WriteStream) {
    this.ansi = createAnsi(Boolean(output.isTTY));
  }

  write(chunk: string): void {
    if (!chunk) {
      return;
    }
    this.buffer += chunk;
    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      this.output.write(this.renderLine(line));
      this.output.write('\n');
      newlineIndex = this.buffer.indexOf('\n');
    }
  }

  flushLine(): void {
    if (!this.buffer) {
      return;
    }
    this.output.write(this.renderLine(this.buffer));
    this.output.write('\n');
    this.buffer = '';
  }

  finish(): void {
    if (!this.buffer) {
      return;
    }
    this.output.write(this.renderLine(this.buffer));
    this.buffer = '';
  }

  private renderLine(raw: string): string {
    const line = raw.replace(/\r$/, '');
    const trimmed = line.trim();

    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      const fence = trimmed.startsWith('```') ? '```' : '~~~';
      if (!this.inCodeBlock) {
        this.inCodeBlock = true;
        this.fence = fence;
      } else if (trimmed.startsWith(this.fence)) {
        this.inCodeBlock = false;
      }
      return '';
    }

    if (this.inCodeBlock) {
      return `${this.ansi.code}  ${line}${this.ansi.reset}`;
    }

    if (/^\s*([-*_])\1\1+\s*$/.test(line)) {
      return `${this.ansi.dim}${'-'.repeat(40)}${this.ansi.reset}`;
    }

    const headingMatch = line.match(/^(\s*)(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const indent = headingMatch[1];
      const text = headingMatch[3].trimEnd();
      return `${indent}${this.ansi.bold}${this.ansi.underline}${text}${this.ansi.reset}`;
    }

    const quoteMatch = line.match(/^(\s*)>\s?(.*)$/);
    if (quoteMatch) {
      const indent = quoteMatch[1];
      const content = quoteMatch[2];
      return `${indent}${this.ansi.dim}|${this.ansi.reset} ${this.applyInline(content)}`;
    }

    const listMatch = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
    if (listMatch) {
      const indent = listMatch[1];
      const marker = listMatch[2];
      const content = listMatch[3];
      return `${indent}${marker} ${this.applyInline(content)}`;
    }

    return this.applyInline(line);
  }

  private applyInline(text: string): string {
    const placeholders: string[] = [];
    let processed = text.replace(/`([^`]+)`/g, (_match, code) => {
      const id = placeholders.length;
      placeholders.push(`${this.ansi.code}${code}${this.ansi.reset}`);
      return `@@CODE_${id}@@`;
    });

    processed = processed.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, url) => {
      return `${this.ansi.underline}${label}${this.ansi.reset} (${this.ansi.dim}${url}${this.ansi.reset})`;
    });

    processed = processed.replace(/\*\*([^*]+)\*\*/g, (_match, content) => {
      return `${this.ansi.bold}${content}${this.ansi.reset}`;
    });

    processed = processed.replace(/__([^_]+)__/g, (_match, content) => {
      return `${this.ansi.bold}${content}${this.ansi.reset}`;
    });

    processed = processed.replace(/(^|[^_])_([^_]+)_/g, (_match, lead, content) => {
      return `${lead}${this.ansi.italic}${content}${this.ansi.reset}`;
    });

    processed = processed.replace(/~~([^~]+)~~/g, (_match, content) => {
      return `${this.ansi.dim}${content}${this.ansi.reset}`;
    });

    processed = processed.replace(/@@CODE_(\d+)@@/g, (_match, index) => {
      const id = Number(index);
      return placeholders[id] ?? '';
    });

    return processed;
  }
}
