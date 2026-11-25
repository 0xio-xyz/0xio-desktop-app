/**
 * The 0xio Signed Message frame, the bytes the extension, the app and the SDK's verifyMessage use:
 * "Octra Signed Message:\n" + utf8ByteLength(message) + "\n" + message. The leading tag means a
 * signed message can never be a transaction pre-image, which is canonical JSON.
 */
export function frameSignedMessage(message: string): string {
  return `Octra Signed Message:\n${new TextEncoder().encode(message).length}\n${message}`;
}
