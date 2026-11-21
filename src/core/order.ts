// ---------------------------------------------------------------------------------------------
// The order things are shown in. Accounts, debts and savings goals are shown in the order they're
// saved, so moving one is moving it in its list. A page only shows some of a list (Accounts doesn't
// show the cards' accounts), so a move swaps it with the next one shown, wherever that is in the list.
// ---------------------------------------------------------------------------------------------

/**
 * Move `id` one place up (-1) or down (+1) among the ones `shown` (ids in the order they're on screen),
 * in place. Returns false when it's already at that end.
 */
export function moveAmong<T extends { id: string }>(list: T[], shown: string[], id: string, dir: -1 | 1): boolean {
  const at = shown.indexOf(id);
  const other = shown[at + dir];
  if (at < 0 || other === undefined) return false;
  const i = list.findIndex((x) => x.id === id);
  const j = list.findIndex((x) => x.id === other);
  if (i < 0 || j < 0) return false;
  [list[i], list[j]] = [list[j], list[i]];
  return true;
}
