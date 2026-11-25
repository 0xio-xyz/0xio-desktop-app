/** placeholderData that keeps the previous result only while the key's address and network match. */
export function keepWithinScope(address: string | undefined, networkId: string) {
  return <T>(previousData: T | undefined, previousQuery?: { queryKey: readonly unknown[] }) =>
    previousQuery?.queryKey[1] === address && previousQuery?.queryKey[2] === networkId
      ? previousData
      : undefined;
}
