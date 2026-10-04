export async function reconcileHistory(
  page,
  initialized,
  historyCursor,
  loadedIds,
  getOlderPage,
) {
  const messages = [...page.messages];
  if (
    initialized && loadedIds.size &&
    !messages.some((message) => loadedIds.has(message.id))
  ) {
    let cursor = page.cursor;
    while (cursor) {
      const olderPage = await getOlderPage(cursor);
      messages.push(...olderPage.messages);
      if (olderPage.messages.some((message) => loadedIds.has(message.id))) {
        break;
      }
      cursor = olderPage.cursor;
    }
  }
  return {
    messages,
    cursor: initialized ? historyCursor : page.cursor,
  };
}
