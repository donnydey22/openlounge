// Public prekey persistence for the single-instance DO calling service. Never stores private keys.
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { PreKeyStore } from "./rcRelay";
export function filePreKeyStore(dir: string): PreKeyStore {
  const filename = (uid: string) => path.join(dir, createHash("sha256").update(uid).digest("hex") + ".json");
  return {
    async get(uid) { try { return JSON.parse(await readFile(filename(uid), "utf8")); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; } },
    async put(uid, value) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const final = filename(uid), temp = final + "." + randomUUID() + ".tmp";
      await writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
      await rename(temp, final);
    },
  };
}
