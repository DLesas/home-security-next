/** Rebuilds the protocol's public corpus for Gradle and checks it against the published file. */
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { relayVectorFiles, RELAY_VECTOR_DIRECTORY } from "../../../packages/protocol/src/relay/vectors/relay-vectors";
const path = process.argv[2];
const filename = "relay-push.json";
const generated = (await relayVectorFiles()).get(filename);
if (!path || !generated || generated !== await Bun.file(join(RELAY_VECTOR_DIRECTORY,filename)).text()) process.exit(1);
await mkdir(dirname(path),{recursive:true});
await Bun.write(path,generated);
