import { SyncTexRecord, SyncTexViewRecord } from "./types";

export function parseSyncTexOutput(output: string): SyncTexRecord[] {
  const records: SyncTexRecord[] = [];
  let current: Partial<SyncTexRecord> = {};
  const flush = (): void => {
    if (current.input && Number.isInteger(current.line) && (current.line ?? 0) > 0) {
      records.push({ input: current.input, line: current.line!, column: current.column });
    }
    current = {};
  };

  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("Input:")) {
      if (current.input) {
        flush();
      }
      current.input = line.slice("Input:".length).trim();
    } else if (line.startsWith("Line:")) {
      current.line = Number.parseInt(line.slice("Line:".length), 10);
    } else if (line.startsWith("Column:")) {
      current.column = Number.parseInt(line.slice("Column:".length), 10);
    } else if (line.startsWith("SyncTeX result end")) {
      flush();
    }
  }
  flush();
  return records;
}

export function parseSyncTexViewOutput(output: string): SyncTexViewRecord[] {
  const records: SyncTexViewRecord[] = [];
  let current: Partial<SyncTexViewRecord> = {};
  const flush = (): void => {
    if (
      Number.isInteger(current.page) && (current.page ?? 0) > 0 &&
      Number.isFinite(current.x) && Number.isFinite(current.y)
    ) {
      records.push(current as SyncTexViewRecord);
    }
    current = {};
  };
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("Page:")) {
      if (current.page !== undefined) {
        flush();
      }
      current.page = Number.parseInt(line.slice("Page:".length), 10);
    } else if (line.startsWith("x:")) {
      current.x = Number.parseFloat(line.slice(2));
    } else if (line.startsWith("y:")) {
      current.y = Number.parseFloat(line.slice(2));
    } else if (line.startsWith("h:")) {
      current.h = Number.parseFloat(line.slice(2));
    } else if (line.startsWith("v:")) {
      current.v = Number.parseFloat(line.slice(2));
    } else if (line.startsWith("W:")) {
      current.width = Number.parseFloat(line.slice(2));
    } else if (line.startsWith("H:")) {
      current.height = Number.parseFloat(line.slice(2));
    } else if (line.startsWith("SyncTeX result end")) {
      flush();
    }
  }
  flush();
  return records;
}
