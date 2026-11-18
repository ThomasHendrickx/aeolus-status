/** Both triggers use the run's creation time, so queue delays do not move a run into another UTC slot. */
export function slotKey(cadence: string, createdAt: string): string {
  if (!['five', 'fifteen'].includes(cadence)) throw new Error('Unknown cadence');
  const minutes = cadence === 'five' ? 5 : 15;
  const timestamp = Date.parse(createdAt);
  if (!Number.isFinite(timestamp)) throw new Error('Invalid run creation time');
  return `${cadence}-${Math.floor(timestamp / (minutes * 60_000))}`;
}
