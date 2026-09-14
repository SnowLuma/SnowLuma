import { Fragment, type ReactNode } from 'react';

/**
 * Tiny dependency-free markdown renderer, scoped to what the EULA / PRIVACY
 * documents actually use: headings (#..####), horizontal rules, blockquotes,
 * ordered / unordered lists, fenced code blocks, paragraphs, and the inline
 * spans bold / italic / code / links.
 *
 * It renders to React elements (never dangerouslySetInnerHTML), so all text is
 * auto-escaped by React and the renderer cannot introduce XSS even though the
 * source text comes over the wire. Links are additionally restricted to
 * http/https/mailto; anything else renders as plain text.
 */
export function Markdown({ content }: { content: string }): ReactNode {
  const blocks = parseBlocks(content.replace(/\r\n?/g, '\n'));
  return (
    <div className="sl-md space-y-3 text-sm leading-relaxed">
      {blocks.map((block, i) => (
        <Fragment key={i}>{renderBlock(block)}</Fragment>
      ))}
    </div>
  );
}

type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'hr' }
  | { type: 'quote'; lines: string[] }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; items: string[] }
  | { type: 'code'; text: string }
  | { type: 'p'; text: string };

function parseBlocks(src: string): Block[] {
  const lines = src.split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // blank line — skip
    if (line.trim() === '') {
      i++;
      continue;
    }

    // fenced code block ``` ... ```
    if (/^\s*```/.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // consume closing fence (or EOF)
      blocks.push({ type: 'code', text: body.join('\n') });
      continue;
    }

    // horizontal rule
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    // heading
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() });
      i++;
      continue;
    }

    // blockquote (consecutive `>` lines)
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      blocks.push({ type: 'quote', lines: quote });
      continue;
    }

    // unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
        i++;
      }
      blocks.push({ type: 'ul', items });
      continue;
    }

    // ordered list
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''));
        i++;
      }
      blocks.push({ type: 'ol', items });
      continue;
    }

    // paragraph — gather until a blank line or a line that starts a new block
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && !startsNewBlock(lines[i])) {
      para.push(lines[i].trim());
      i++;
    }
    blocks.push({ type: 'p', text: para.join(' ') });
  }

  return blocks;
}

function startsNewBlock(line: string): boolean {
  return (
    /^\s*```/.test(line) ||
    /^(#{1,6})\s+/.test(line) ||
    /^\s*>/.test(line) ||
    /^\s*[-*+]\s+/.test(line) ||
    /^\s*\d+[.)]\s+/.test(line) ||
    /^\s*([-*_])\s*(\1\s*){2,}$/.test(line)
  );
}

function renderBlock(block: Block): ReactNode {
  switch (block.type) {
    case 'heading': {
      const cls = [
        'text-xl font-semibold tracking-tight',
        'text-lg font-semibold tracking-tight',
        'text-base font-semibold',
        'text-sm font-semibold',
        'text-sm font-semibold text-muted-foreground',
        'text-xs font-semibold text-muted-foreground',
      ][block.level - 1];
      const inner = renderInline(block.text);
      switch (block.level) {
        case 1:
          return <h1 className={cls}>{inner}</h1>;
        case 2:
          return <h2 className={cls}>{inner}</h2>;
        case 3:
          return <h3 className={cls}>{inner}</h3>;
        case 4:
          return <h4 className={cls}>{inner}</h4>;
        case 5:
          return <h5 className={cls}>{inner}</h5>;
        default:
          return <h6 className={cls}>{inner}</h6>;
      }
    }
    case 'hr':
      return <hr className="border-border" />;
    case 'quote':
      return (
        <blockquote className="border-l-2 border-primary/40 pl-3 text-muted-foreground">
          {block.lines.map((l, i) => (
            <p key={i}>{renderInline(l)}</p>
          ))}
        </blockquote>
      );
    case 'ul':
      return (
        <ul className="list-disc space-y-1 pl-5">
          {block.items.map((it, i) => (
            <li key={i}>{renderInline(it)}</li>
          ))}
        </ul>
      );
    case 'ol':
      return (
        <ol className="list-decimal space-y-1 pl-5">
          {block.items.map((it, i) => (
            <li key={i}>{renderInline(it)}</li>
          ))}
        </ol>
      );
    case 'code':
      return (
        <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
          <code>{block.text}</code>
        </pre>
      );
    case 'p':
      return <p>{renderInline(block.text)}</p>;
  }
}

// Inline spans: `code`, **bold**, *italic* / _italic_, [text](url).
//
// Scanned in ONE pass with a global regex (lastIndex advances), and every
// span uses a *bounded* negated class (`{1,N}`). Both matter: a greedy
// UNbounded negated class (`[^\]]+`) on bracket-/asterisk-dense text causes
// O(n²) catastrophic backtracking and can hang the render thread on a large
// doc. The caps are far larger than any real inline span; anything longer
// renders literally rather than risking a hang.
const INLINE_RE =
  /`[^`\n]{1,2048}`|\*\*[^*\n]{1,2048}\*\*|\*[^*\n]{1,2048}\*|_[^_\n]{1,2048}_|\[[^\]\n]{1,512}\]\([^)\s]{1,2048}\)/g;

function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = new RegExp(INLINE_RE.source, 'g'); // fresh instance: own lastIndex
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('`')) {
      out.push(<code key={key++} className="rounded bg-muted px-1 py-0.5 text-xs">{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith('**')) {
      out.push(<strong key={key++}>{renderInline(tok.slice(2, -2))}</strong>);
    } else if (tok.startsWith('*') || tok.startsWith('_')) {
      out.push(<em key={key++}>{renderInline(tok.slice(1, -1))}</em>);
    } else {
      // [label](href) — tok already matched the bounded link shape.
      const link = tok.match(/^\[([^\]]*)\]\(([^)\s]+)\)$/);
      if (link) out.push(safeLink(link[2], link[1], key++));
      else out.push(tok);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));

  return out;
}

function safeLink(href: string, label: string, key: number): ReactNode {
  const ok = /^(https?:|mailto:)/i.test(href);
  if (!ok) return <Fragment key={key}>{label}</Fragment>;
  return (
    <a key={key} href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">
      {label}
    </a>
  );
}
