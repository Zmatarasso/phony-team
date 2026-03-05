import { readFile, writeFile } from "fs/promises";
import path from "path";

export interface DayRecord {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

type TokenUsageFile = Record<string, DayRecord>;

function today(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

export class TokenTracker {
  private readonly filePath: string;
  private data: TokenUsageFile = {};
  private loaded = false;

  constructor(filePath?: string) {
    this.filePath = path.resolve(filePath ?? process.env["TOKEN_USAGE_FILE"] ?? "./token-usage.json");
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.filePath, "utf8");
      this.data = JSON.parse(raw) as TokenUsageFile;
    } catch {
      this.data = {};
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    await writeFile(this.filePath, JSON.stringify(this.data, null, 2) + "\n", "utf8");
  }

  async getUsage(): Promise<TokenUsageFile> {
    await this.load();
    return { ...this.data };
  }

  async recordTokens(inputDelta: number, outputDelta: number): Promise<void> {
    if (inputDelta === 0 && outputDelta === 0) return;
    await this.load();
    const key = today();
    const existing = this.data[key] ?? { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
    this.data[key] = {
      input_tokens: existing.input_tokens + inputDelta,
      output_tokens: existing.output_tokens + outputDelta,
      total_tokens: existing.total_tokens + inputDelta + outputDelta,
    };
    await this.save();
  }
}
