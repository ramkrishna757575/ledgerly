import type { ReactNode } from 'react';

// Headings, paragraphs, **bold** and *italic*, from plain text, with no HTML ever let through.
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g).map((part, i) => {
    if (/^\*\*[^*]+\*\*$/.test(part)) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (/^\*[^*]+\*$/.test(part)) return <em key={i}>{part.slice(1, -1)}</em>;
    return part;
  });
}

export function Prose({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-3 text-sm">
      {text.split(/\n{2,}/).map((block, i) => {
        const heading = block.match(/^(#{1,3}) (.+)$/);
        if (heading) return heading[1] === '#' ? <h1 key={i} className="text-2xl font-semibold">{heading[2]}</h1> : <h2 key={i} className="font-medium">{heading[2]}</h2>;
        return <p key={i} className="text-muted">{inline(block.replace(/\n/g, ' '))}</p>;
      })}
    </div>
  );
}
