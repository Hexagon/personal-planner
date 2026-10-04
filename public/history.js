export async function reconcileHistory(
  page,
  initialized,
  historyCursor,
  coveredIds,
  getOlderPage,
) {
  const messages = [...page.messages];
  if (
    initialized && coveredIds.size &&
    !messages.some((message) => coveredIds.has(message.id))
  ) {
    let cursor = page.cursor;
    while (cursor) {
      const olderPage = await getOlderPage(cursor);
      messages.push(...olderPage.messages);
      if (olderPage.messages.some((message) => coveredIds.has(message.id))) {
        break;
      }
      cursor = olderPage.cursor;
    }
  }
  return {
    messages,
    cursor: initialized && coveredIds.size ? historyCursor : page.cursor,
  };
}
