import { extractSection } from './extract.js';
import { contentRecoveryPrompt } from './prompts.js';

export function parseContentDraft(raw, id) {
  const ex = extractSection(raw, id, { minChars: 1 });
  if (ex.status !== 'ok' || !Array.isArray(ex.meta?.missing_information) ||
      ex.meta.missing_information.some(item => typeof item !== 'string' || !item.trim()) ||
      (!ex.meta.missing_information.length && ex.body.length < 200)) return null;
  return ex;
}

// One autonomous recovery per unchanged assignment. Persist before sending so
// resuming an uncertain turn cannot silently spend another request.
export async function recoverContentDraft({ book, chapter, section, draft, request, persist }) {
  if (!draft.meta.missing_information.length || draft.recoveryAttempted) return draft;
  const attempted = { ...draft, recoveryAttempted: true };
  await persist(attempted);
  const response = await request(contentRecoveryPrompt({ book, outline: book.outline,
    bible: book.bible, chapter, sections: [section], withContext: true, draft }));
  const ex = response?.data || parseContentDraft(response?.text || '', section.id);
  if (!ex) return attempted;
  const recovered = { ...attempted, md: ex.body, meta: ex.meta, recoveredAt: Date.now() };
  await persist(recovered);
  return recovered;
}

export function contentInputRequests(sections, drafts) {
  return sections.filter(s => drafts.get(s.id)?.meta.missing_information.length)
    .map(s => ({ id: s.id, title: s.title,
      missing: [...drafts.get(s.id).meta.missing_information] }));
}
