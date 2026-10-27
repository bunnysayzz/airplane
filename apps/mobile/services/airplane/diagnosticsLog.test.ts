// SPDX-License-Identifier: Apache-2.0
// Automatic diagnostics log file tests: formatting, rotation, the
// writer over an in-memory port, and the privacy boundary — log lines
// carry diagnostics data only, never post text or message ids.

import {
  attachDiagnosticsLogWriter,
  DiagnosticsLogWriter,
  formatDiagnosticsLogLine,
  MAX_DIAGNOSTICS_LOG_BYTES,
  MAX_DIAGNOSTICS_LOG_LINES,
  rotateDiagnosticsLogLines,
  type DiagnosticsLogFilePort,
} from './diagnosticsLog';
import {
  recordAdvertiseFailure,
  recordMessage,
  recordPeerSeen,
  resetDiagnosticsForTests,
  type DiagnosticsMessage,
} from './diagnostics';

function memoryPort(initial = ''): DiagnosticsLogFilePort & { content: string } {
  const port: DiagnosticsLogFilePort & { content: string } = {
    content: initial,
    read: async () => (port.content.length > 0 ? port.content : null),
    write: async (content: string) => {
      port.content = content;
    },
  };
  return port;
}

describe('diagnostics log line format', () => {
  test('timestamped kind + detail, newlines stripped, detail truncated', () => {
    const line = formatDiagnosticsLogLine(Date.parse('2026-10-27T00:00:00.000Z'), 'advertise', 'failed\nsecond line');
    expect(line).toBe('2026-10-27T00:00:00.000Z advertise failed second line');
    const long = formatDiagnosticsLogLine(0, 'scan', 'x'.repeat(1000));
    expect(long.length).toBeLessThanOrEqual('1970-01-01T00:00:00.000Z scan '.length + 240);
  });

  test('rotation keeps the newest lines under both caps', () => {
    const lines = Array.from({ length: MAX_DIAGNOSTICS_LOG_LINES + 10 }, (_, i) => `line-${i}`);
    const kept = rotateDiagnosticsLogLines(lines);
    expect(kept.length).toBe(MAX_DIAGNOSTICS_LOG_LINES);
    expect(kept[0]).toBe('line-10');
    expect(kept[kept.length - 1]).toBe(`line-${MAX_DIAGNOSTICS_LOG_LINES + 9}`);
    const big = rotateDiagnosticsLogLines(['x'.repeat(MAX_DIAGNOSTICS_LOG_BYTES)]);
    expect(big).toEqual([]);
  });
});

describe('diagnostics log writer', () => {
  test('loads a surviving file, appends, and flushes to the port', async () => {
    const port = memoryPort('2026-10-27T00:00:00.000Z app started\n');
    const writer = new DiagnosticsLogWriter(port);
    await writer.load();
    expect(writer.getLineCount()).toBe(1);
    writer.append('2026-10-27T00:00:01.000Z scan started');
    await writer.flush();
    expect(port.content).toContain('app started');
    expect(port.content).toContain('scan started');
    expect(writer.getLineCount()).toBe(2);
  });

  test('a failing port never throws to the app', async () => {
    const port: DiagnosticsLogFilePort = {
      read: async () => {
        throw new Error('no storage');
      },
      write: async () => {
        throw new Error('no storage');
      },
    };
    const writer = new DiagnosticsLogWriter(port);
    await writer.load();
    writer.append('2026-10-27T00:00:00.000Z app started');
    await writer.flush();
    expect(writer.getLineCount()).toBe(1);
  });
});

describe('diagnostics log sink wiring and privacy', () => {
  beforeEach(() => {
    resetDiagnosticsForTests();
  });

  test('collector events become log lines; post text and message ids never do', async () => {
    const port = memoryPort();
    const writer = new DiagnosticsLogWriter(port);
    await writer.load();
    attachDiagnosticsLogWriter(writer);

    recordAdvertiseFailure('addService: native error was empty');
    recordPeerSeen('tag:0123456789abcdef', -60, '0123456789abcdef');
    const message: DiagnosticsMessage = {
      id: 'deadbeef'.repeat(8),
      sequence: null,
      sizeBytes: 180,
      direction: 'outbound',
      attempts: [{ transport: 'relay', atMs: Date.now(), outcome: 'ok', detail: 'published to 2 relays' }],
      finalStatus: 'relayed',
    };
    recordMessage(message);
    await writer.flush();

    const lines = writer.getLines();
    expect(lines.some((l) => l.includes('advertise failed addService'))).toBe(true);
    expect(lines.some((l) => l.includes('peer seen tag:0123456789abcdef'))).toBe(true);
    expect(lines.some((l) => l.includes('message outbound 180B relayed'))).toBe(true);
    // The planted values below appear nowhere in any log line.
    const joined = lines.join('\n');
    expect(joined).not.toContain('deadbeef');
    expect(joined).not.toContain('hello secret post text');
  });
});
