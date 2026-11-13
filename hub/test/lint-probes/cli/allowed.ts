// Lint probe: the CLI may import control-protocol, @hsn/protocol, node:net and neverthrow.
// Expect: clean
import "../src/control-protocol/index.ts";
import "@hsn/protocol";
import "node:net";
import "neverthrow";
import "./other.ts";
