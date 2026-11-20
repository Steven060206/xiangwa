export async function openGamePane(page, view) {
  const tab = page.locator(`#game-navigation [data-view="${view}"]`);
  if (view === 'map' && !await tab.isVisible()) await page.locator('#map-focus').click();
  else await tab.click();
}

export async function locateSeat(page, playerId) {
  await page.locator('#seats-toggle').click();
  await page.locator(`#table-seats button[data-player-id="${playerId}"]`).click();
}
