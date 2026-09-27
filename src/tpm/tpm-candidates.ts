import type { TpmItem } from "./tpm-store.ts";

const STOPWORDS = new Set(
  "the and for with that this from have has had not are was were will would should could into onto about when then than they them their there what which while where your you our its can cannot need needs".split(
    " ",
  ),
);

export function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? []) {
    if (!STOPWORDS.has(word)) out.add(word);
  }
  return out;
}

function mentions(haystack: string, needle: string | undefined): boolean {
  return (
    needle !== undefined && needle.trim().length >= 3 && haystack.toLowerCase().includes(needle.trim().toLowerCase())
  );
}

export function selectCandidates(
  subject: { id?: string; title: string; body: string; externalRef?: string },
  pool: readonly TpmItem[],
  limit: number,
): TpmItem[] {
  const subjectText = `${subject.title}\n${subject.body}`;
  const subjectTokens = tokens(subjectText);
  const scored: Array<{ item: TpmItem; score: number }> = [];
  for (const item of pool) {
    if (item.id === subject.id) continue;
    const itemText = `${item.title}\n${item.body}`;
    const itemTokens = tokens(itemText);
    let shared = 0;
    for (const token of subjectTokens) if (itemTokens.has(token)) shared += 1;
    const overlap =
      subjectTokens.size && itemTokens.size ? shared / Math.sqrt(subjectTokens.size * itemTokens.size) : 0;
    const referenced =
      mentions(subjectText, item.externalRef) ||
      mentions(subjectText, item.title) ||
      mentions(itemText, subject.externalRef) ||
      mentions(itemText, subject.title);
    const score = overlap + (referenced ? 1 : 0);
    if (score > 0) scored.push({ item, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.item.createdAt - b.item.createdAt)
    .slice(0, limit)
    .map((entry) => entry.item);
}
