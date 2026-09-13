// These helpers opt in only for item books; prose and fiction keep their own review flow.
export function isItemBook(book) {
  return book?.contentMode === 'items';
}

export function invalidateItemReview(book) {
  if (!isItemBook(book)) return;
  book.itemQuality = { ...book.itemQuality, passed: false, signature: null, pending: true };
}

export function syncItemEdit(book, section) {
  if (!isItemBook(book) || section.kind !== 'item') return;
  section.text = section.md ?? section.text ?? '';
  section.md = section.text;
  invalidateItemReview(book);
}

export function itemReviewView(book) {
  const issues = (book.itemQuality?.issues || []).map(x => ({
    section: String(x.id), label: 'รายชิ้น', text: x.reason, counted: true,
  }));
  if (book.itemQuality?.pending) issues.unshift({
    label: 'รอตรวจซ้ำ', text: 'เนื้อหาเปลี่ยนแล้ว กดไปต่อเพื่อตรวจคุณภาพฉบับล่าสุด', counted: true,
  });
  return { total: issues.length, totalCounted: issues.length,
    chapters: [{ n: 'รายชิ้น', counted: issues.length, issues }] };
}
