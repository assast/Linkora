export type RelativePosition = 'before' | 'after';

export function moveItem<T extends { id: string }>(items: T[], id: string, targetId: string, position: RelativePosition): T[] {
  const next = [...items];
  const sourceIndex = next.findIndex(item => item.id === id);
  if (sourceIndex < 0 || id === targetId) return next;
  const [moving] = next.splice(sourceIndex, 1);
  const targetIndex = next.findIndex(item => item.id === targetId);
  if (targetIndex < 0) return items;
  next.splice(targetIndex + (position === 'after' ? 1 : 0), 0, moving);
  return next;
}
