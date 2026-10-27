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

describe('diagnostics log restart survival', () => {
  test('appends during load are buffered, not wiped by the read', async () => {
    let resolveRead!: (value: string | null) => void;
    const port: DiagnosticsLogFilePort & { content: string } = {
      content: '2026-10-27T00:00:00.000Z app started\n2026-10-27T00:00:01.000Z scan started\n',
      read: () => new Promise((resolve) => {
        resolveRead = resolve;
      }),
      write: async (content: string) => {
        port.content = content;
      },
    };
    const writer = new DiagnosticsLogWriter(port);
    const loading = writer.load();
    // These land while the file read is still in flight. Before the
    // fix, the read completing below replaced the line list and wiped
    // them; now they are buffered and drained in order.
    writer.append('2026-10-27T00:00:02.000Z app foreground');
    writer.append('2026-10-27T00:00:03.000Z adapter on');
    expect(writer.getLineCount()).toBe(2);
    resolveRead(port.content);
    await loading;
    expect(writer.getLoadedFromFileCount()).toBe(2);
    expect(writer.getLoadOk()).toBe(true);
    expect(writer.getLines()).toEqual([
      '2026-10-27T00:00:00.000Z app started',
      '2026-10-27T00:00:01.000Z scan started',
      '2026-10-27T00:00:02.000Z app foreground',
      '2026-10-27T00:00:03.000Z adapter on',
    ]);
    // The drained lines reach the file without any further append.
    for (let i = 0; i < 20 && !port.content.includes('adapter on'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(port.content).toContain('adapter on');
  });

  test('lines appended during a failed write are re-flushed, not stranded', async () => {
    let failFirstWrite!: (error: Error) => void;
    let writeCalls = 0;
    const port: DiagnosticsLogFilePort & { content: string } = {
      content: '',
      read: async () => (port.content.length > 0 ? port.content : null),
      write: (content: string) => {
        writeCalls += 1;
        if (writeCalls === 1) {
          return new Promise<void>((_resolve, reject) => {
            failFirstWrite = reject;
          });
        }
        port.content = content;
        return Promise.resolve();
      },
    };
    const writer = new DiagnosticsLogWriter(port);
    await writer.load();
    writer.append('2026-10-27T00:00:00.000Z app started');
    // This append lands while the first write is still in flight, so
    // it only marks the buffer dirty. Before the fix, the failed write
    // left it stranded in memory with no flush scheduled until the
    // next append, so closing the app right after lost the tail.
    writer.append('2026-10-27T00:00:01.000Z scan started');
    failFirstWrite(new Error('transient failure'));
    for (let i = 0; i < 20 && !port.content.includes('scan started'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(port.content).toContain('app started');
    expect(port.content).toContain('scan started');
    expect(writer.getLastWriteStatus().ok).toBe(true);
  });

  test('load and write status are visible for the device re-check', async () => {
    const port = memoryPort('line-one\nline-two\nline-three\n');
    const writer = new DiagnosticsLogWriter(port);
    expect(writer.getLastWriteStatus()).toEqual({ ok: null, atMs: null, error: null });
    await writer.load();
    expect(writer.getLoadedFromFileCount()).toBe(3);
    expect(writer.getLoadOk()).toBe(true);
    writer.append('line-four');
    await writer.flush();
    expect(writer.getLastWriteStatus().ok).toBe(true);
    expect(writer.getLastWriteStatus().error).toBeNull();

    const failingPort: DiagnosticsLogFilePort = {
      read: async () => {
        throw new Error('no storage');
      },
      write: async () => {
        throw new Error('no storage');
      },
    };
    const failingWriter = new DiagnosticsLogWriter(failingPort);
    await failingWriter.load();
    expect(failingWriter.getLoadedFromFileCount()).toBe(0);
    expect(failingWriter.getLoadOk()).toBe(false);
    failingWriter.append('line-one');
    await failingWriter.flush();
    expect(failingWriter.getLastWriteStatus().ok).toBe(false);
    expect(failingWriter.getLastWriteStatus().error).toBe('no storage');
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
