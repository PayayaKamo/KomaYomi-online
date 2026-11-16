/**
 * Small, dependency-free Markdown renderer.
 * Shared by the editor preview and HTML export so both look identical.
 *
 * Design notes:
 * - Everything is HTML-escaped first; inline HTML in notes is never executed.
 * - Supports headings, bold/italic/strikethrough, inline code, fenced code,
 *   links, ordered/unordered lists (one nesting level), block quotes, tables,
 *   horizontal rules and hard line breaks.
 * - Plain text notes saved before Markdown support render as-is (newlines
 *   become <br>), so old data upgrades without loss.
 */

export function escapeHtml(input: string): string {
  return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inline(input: string): string {
  const codes: string[] = [];
  let s = escapeHtml(input);

  // Protect inline code before other inline rules run.
  s = s.replace(/`([^`]+)`/g, (_m, code: string) => {
    codes.push(`<code>${code}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });

  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt: string, src: string) => {
    const safe = /^https?:\/\//i.test(src) ? src : '';
    return safe ? `<img src="${safe}" alt="${alt}" loading="lazy" />` : alt;
  });

  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, href: string) => {
    const safe = /^(https?:|mailto:|#|\/)/i.test(href) ? href : '#';
    return `<a href="${safe}" target="_blank" rel="noreferrer noopener">${text}</a>`;
  });

  // Underline is the one inline HTML the editor emits; allow exactly this tag back in.
  s = s.replace(/&lt;u&gt;/g, '<u>').replace(/&lt;\/u&gt;/g, '</u>');

  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');

  // NUL marks inline-code placeholders and is restored at the end, so the control character must be matched here.
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)] ?? '');
}

const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

function isTableStart(lines: string[], i: number): boolean {
  if (!lines[i]?.includes('|') || i + 1 >= lines.length) return false;
  return /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1]) && lines[i + 1].includes('-');
}

/** `<div align="center">…</div>` is the only block HTML the editor emits, for text alignment. */
const ALIGN_RE = /^\s*<div align="(left|center|right)">(.*)<\/div>\s*$/;

const FENCE_RE = /^```(\w*)\s*$/;

function isBlockStart(lines: string[], i: number): boolean {
  const line = lines[i];
  if (ALIGN_RE.test(line)) return true;
  if (FENCE_RE.test(line)) return true;
  if (/^#{1,6}\s+/.test(line)) return true;
  if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) return true;
  if (/^\s*>/.test(line)) return true;
  if (LIST_RE.test(line)) return true;
  if (isTableStart(lines, i)) return true;
  return false;
}

function parseTable(lines: string[], start: number): { html: string; next: number } {
  const splitRow = (line: string) =>
    line
      .replace(/^\s*\|/, '')
      .replace(/\|\s*$/, '')
      .split('|')
      .map((c) => c.trim());

  const head = splitRow(lines[start]);
  const aligns = splitRow(lines[start + 1]).map((cell) => {
    if (/^:-+:$/.test(cell)) return 'center';
    if (/^-+:$/.test(cell)) return 'right';
    return 'left';
  });

  let i = start + 2;
  const rows: string[][] = [];
  while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
    rows.push(splitRow(lines[i]));
    i++;
  }

  const th = head.map((cell, idx) => `<th style="text-align:${aligns[idx] ?? 'left'}">${inline(cell)}</th>`).join('');
  const body = rows
    .map(
      (row) =>
        `<tr>${row
          .map((cell, idx) => `<td style="text-align:${aligns[idx] ?? 'left'}">${inline(cell)}</td>`)
          .join('')}</tr>`,
    )
    .join('');
  return { html: `<table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`, next: i };
}

function parseList(lines: string[], start: number): { html: string; next: number } {
  const first = lines[start].match(LIST_RE);
  if (!first) return { html: '', next: start + 1 };
  const baseIndent = first[1].length;
  const ordered = /^\d/.test(first[2]);
  const items: { text: string; nested: string[] }[] = [];
  let i = start;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) break;
    const m = line.match(LIST_RE);
    if (m && m[1].length === baseIndent) {
      items.push({ text: m[3], nested: [] });
      i++;
      continue;
    }
    const indent = (line.match(/^\s*/) ?? [''])[0].length;
    if (indent > baseIndent) {
      // Deeper content belongs to the previous item: render it as a nested block.
      const chunk: string[] = [];
      while (i < lines.length) {
        const l = lines[i];
        if (!l.trim()) break;
        const li = (l.match(/^\s*/) ?? [''])[0].length;
        if (li <= baseIndent) break;
        chunk.push(l);
        i++;
      }
      const min = Math.min(...chunk.map((l) => (l.match(/^\s*/) ?? [''])[0].length));
      items[items.length - 1].nested.push(blocks(chunk.map((l) => l.slice(min))).join('\n'));
      continue;
    }
    if (isBlockStart(lines, i)) break;
    items[items.length - 1].text += `\n${line.trim()}`;
    i++;
  }

  const tag = ordered ? 'ol' : 'ul';
  const body = items
    .map((item) => `<li>${inline(item.text).replace(/\n/g, '<br />')}${item.nested.join('')}</li>`)
    .join('');
  return { html: `<${tag}>${body}</${tag}>`, next: i };
}

function blocks(lines: string[]): string[] {
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = line.match(FENCE_RE);
    if (fence) {
      const lang = fence[1];
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // closing fence
      out.push(
        `<pre class="md-code"${lang ? ` data-lang="${escapeHtml(lang)}"` : ''}><code>${escapeHtml(buf.join('\n'))}</code></pre>`,
      );
      continue;
    }

    const aligned = line.match(ALIGN_RE);
    if (aligned) {
      out.push(`<div style="text-align:${aligned[1]}">${inline(aligned[2])}</div>`);
      i++;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2].trim())}</h${level}>`);
      i++;
      continue;
    }

    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      out.push('<hr />');
      i++;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${blocks(quote).join('\n')}</blockquote>`);
      continue;
    }

    if (isTableStart(lines, i)) {
      const table = parseTable(lines, i);
      out.push(table.html);
      i = table.next;
      continue;
    }

    if (LIST_RE.test(line)) {
      const list = parseList(lines, i);
      out.push(list.html);
      i = list.next;
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines, i)) {
      para.push(lines[i]);
      i++;
    }
    if (!para.length) {
      // Defensive: every block marker above must consume its input. If a future marker
      // is recognized by isBlockStart but not handled yet, degrade it to plain text and
      // advance so malformed markdown can never stall the render loop.
      out.push(`<p>${inline(lines[i])}</p>`);
      i++;
      continue;
    }
    out.push(`<p>${inline(para.join('\n')).replace(/\n/g, '<br />')}</p>`);
  }

  return out;
}

export function renderMarkdown(src: string): string {
  if (!src || !src.trim()) return '';
  return blocks(src.replace(/\r\n?/g, '\n').split('\n')).join('\n');
}

/** Plain-text excerpt for search results / list previews. */
export function markdownExcerpt(src: string, max = 80): string {
  const text = src
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<\/?(?:u|div)[^>]*>/g, '')
    .replace(/[#>*_~|-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
