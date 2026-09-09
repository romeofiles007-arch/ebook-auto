// Kept separate from writing usage: CEO may use a different model.
export function addCeoUsage(previous = {}, res) {
  const m = res?.meta;
  if (m?.promptTokens == null && m?.completionTokens == null) return previous;
  const next = { ...previous, turns: (previous.turns || 0) + 1,
    promptTokens: (previous.promptTokens || 0) + (Number(m.promptTokens) || 0),
    completionTokens: (previous.completionTokens || 0) + (Number(m.completionTokens) || 0) };
  return next;
}
export function ceoUsageLabel(u) {
  return u?.turns ? `CEO API · ${u.turns} ครั้ง · input ${u.promptTokens} / output ${u.completionTokens} tokens · คิดเงินแยกจากงานเขียน` : '';
}
