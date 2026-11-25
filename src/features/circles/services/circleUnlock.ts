import { fetchSealedAsset, type CircleReader } from "src/features/dapp/services/circleRead";
import { openSealedAsset, type SealedAsset } from "src/features/circles/services/circleSealed";
import type { CircleRecord } from "src/features/circles/services/circleLibrary";

export async function checkPassphrase(p: {
  rpcUrl: string;
  circle: CircleRecord;
  reader: CircleReader;
  passphrase: string;
}): Promise<"ok" | "wrong" | "unchecked"> {
  const file = p.circle.files
    .filter((f) => f.status === "confirmed")
    .sort((a, b) => a.size - b.size)[0];
  if (!file) return "ok";
  let asset: SealedAsset;
  try {
    asset = await fetchSealedAsset(p.rpcUrl, p.circle.id, file.path, p.reader);
    if (typeof asset?.ciphertext_b64 !== "string" || !asset.key_id) return "unchecked";
  } catch {
    return "unchecked";
  }
  try {
    await openSealedAsset(p.circle.id, asset, p.passphrase);
    return "ok";
  } catch {
    return "wrong";
  }
}
