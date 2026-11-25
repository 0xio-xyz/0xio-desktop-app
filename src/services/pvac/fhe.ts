/** Strip "hfhe_v1|" prefix - pvac-handler expects raw base64 for all ops except encode */
export function stripCipherPrefix(cipher: string): string {
  return cipher.startsWith("hfhe_v1|") ? cipher.slice(8) : cipher;
}

/** Replace enc(N) tokens in a JSON params string with actual FHE ciphertexts (right-to-left) */
export async function expandEncParams(
  paramsJson: string,
  encryptFn: (value: number) => Promise<string>,
): Promise<string> {
  const re = /enc\((-?\d+)\)/g;
  const matches: Array<{ start: number; end: number; value: number }> = [];
  let m;
  while ((m = re.exec(paramsJson)) !== null) {
    matches.push({ start: m.index, end: m.index + m[0].length, value: parseInt(m[1]) });
  }
  if (matches.length === 0) return paramsJson;
  let result = paramsJson;
  for (let i = matches.length - 1; i >= 0; i--) {
    const r = matches[i];
    const cipher = await encryptFn(r.value);
    result = result.substring(0, r.start) + '"' + cipher + '"' + result.substring(r.end);
  }
  return result;
}

export async function tryFheDecrypt(
  val: unknown,
  decryptFn: (cipher: string) => Promise<number>,
): Promise<number | null> {
  if (typeof val !== "string" || val.length < 100) return null;
  try {
    return await decryptFn(stripCipherPrefix(val));
  } catch {
    return null;
  }
}
