/** Public events contain only information that every player may know. */
export function emitGameEvent(play, event) {
  play.itemEvents ??= [];
  const entry = { id: `event_${play.itemEvents.length + 1}`, cycle: play.round.silent.cycle, ...event };
  play.itemEvents.push(entry);
  return entry;
}
