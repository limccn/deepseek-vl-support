// Numbered-menu wizard built on node:readline/promises (zero dependencies).
// Bilingual prompts, every step has a default, Enter accepts the default,
// and every step is skippable. Non-interactive installs never call these.
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export interface MenuOption {
  value: string;
  label: string;
}

export interface MenuSpec {
  prompt: string;
  options: MenuOption[];
  default?: string;
}

export interface InputSpec {
  prompt: string;
  default?: string;
  hint?: string;
}

function makeRl() {
  return createInterface({ input, output });
}

function formatMenu(spec: MenuSpec): string {
  const lines = [spec.prompt];
  spec.options.forEach((opt, i) => {
    const marker = opt.value === spec.default ? " (default 默认)" : "";
    lines.push(`  ${i + 1}) ${opt.label}${marker}`);
  });
  const def = spec.default ? ` [${spec.default}]` : "";
  lines.push(`> 选择/select (1-${spec.options.length}${def}): `);
  return lines.join("\n");
}

/** Ask a numbered-menu question; returns the chosen option value. */
export async function askMenu(spec: MenuSpec): Promise<string> {
  const rl = makeRl();
  try {
    for (;;) {
      const answer = (await rl.question(formatMenu(spec))).trim();
      if (answer === "" && spec.default !== undefined) return spec.default;
      const n = Number(answer);
      if (Number.isInteger(n) && n >= 1 && n <= spec.options.length) {
        return spec.options[n - 1].value;
      }
      output.write(`Invalid choice. 输入无效，请重新选择。\n`);
    }
  } finally {
    rl.close();
  }
}

/** Ask a free-text question; Enter returns the default. */
export async function askInput(spec: InputSpec): Promise<string> {
  const rl = makeRl();
  try {
    const hint = spec.hint ? ` (${spec.hint})` : "";
    const def = spec.default !== undefined ? ` [${spec.default}]` : "";
    const answer = (await rl.question(`${spec.prompt}${hint}${def}: `)).trim();
    return answer === "" ? (spec.default ?? "") : answer;
  } finally {
    rl.close();
  }
}

/** Ask a hidden (masked) input. Falls back to plain input on non-TTY. */
export async function askSecret(spec: InputSpec): Promise<string> {
  if (!input.isTTY || !output.isTTY) return askInput(spec);
  const def = spec.default !== undefined ? ` [回车/Enter=默认]` : ` [回车/Enter=跳过]`;
  output.write(`${spec.prompt}${def}: `);
  return new Promise<string>((resolve) => {
    const stdin = input;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          output.write("\n");
          cleanup();
          stdin.off("data", onData);
          resolve(value === "" ? (spec.default ?? "") : value);
          return;
        }
        if (ch === "") {
          // Ctrl+C: cancel → treat as skip
          output.write("^C\n");
          cleanup();
          stdin.off("data", onData);
          resolve("");
          return;
        }
        if (ch === "" || ch === "\b") {
          if (value.length) {
            value = value.slice(0, -1);
            output.write("\b \b");
          }
          continue;
        }
        value += ch;
        output.write("*");
      }
    };
    stdin.on("data", onData);
  });
}
