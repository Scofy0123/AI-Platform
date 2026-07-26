import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type CredentialIsolationProbeResult,
  probeCodexCredentialIsolation,
} from "../apps/api/src/security/runtime-safety-gate.js";

interface ProbeCliInput {
  binaryPath: string;
  workspacePath: string;
}

interface SecurityProbeCliOptions {
  argv?: readonly string[];
  probe?: (input: ProbeCliInput) => Promise<CredentialIsolationProbeResult>;
  write?: (value: string) => void;
}

export async function runSecurityProbeCli(options: SecurityProbeCliOptions = {}): Promise<0 | 1> {
  const argv = options.argv ?? process.argv.slice(2);
  const binaryPath =
    readOption(argv, "--binary") ?? resolve(process.cwd(), "node_modules", ".bin", "codex");
  const workspacePath = readOption(argv, "--workspace") ?? process.cwd();
  const probe = options.probe ?? probeCodexCredentialIsolation;
  const result = await probe({ binaryPath, workspacePath });

  (options.write ?? ((value) => process.stdout.write(value)))(
    `${JSON.stringify(result, null, 2)}\n`,
  );
  return result.status === "ISOLATED" && result.safeForMultiUser ? 0 : 1;
}

function readOption(argv: readonly string[], name: string): string | undefined {
  const optionIndex = argv.indexOf(name);
  if (optionIndex === -1) return undefined;
  const value = argv[optionIndex + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(resolve(entrypoint)).href) {
  process.exitCode = await runSecurityProbeCli();
}
