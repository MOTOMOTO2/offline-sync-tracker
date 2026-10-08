/** Id generation. Ids are made on the device so a write never waits for a server. */

export function newId(prefix = ''): string {
  const raw =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return prefix ? `${prefix}_${raw}` : raw;
}

export function newEntryId(): string {
  return newId('e');
}

export function newOpId(): string {
  return newId('op');
}

export function newDeviceId(): string {
  return newId('dev');
}
