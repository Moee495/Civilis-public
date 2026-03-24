export function buildTextMemoryContent(
  summary: string,
  extra: Record<string, unknown> = {},
): string {
  const normalized = summary.trim();

  return JSON.stringify({
    summary: normalized,
    lesson: normalized,
    text: normalized,
    ...extra,
  });
}

export function extractMemorySummary(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (content && typeof content === 'object') {
    const record = content as Record<string, unknown>;
    const candidates = [record.summary, record.lesson, record.text, record.description];

    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate;
      }
    }

    try {
      return JSON.stringify(content);
    } catch {
      return '[memory]';
    }
  }

  return String(content ?? '');
}
