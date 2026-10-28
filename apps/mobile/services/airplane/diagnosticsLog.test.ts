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
  getDiagnosticsSnapshot,
  recordAdvertiseFailure,
  recordDedupDrop,
  recordFragmentsReceived,
  recordFragmentsSent,
  recordIncompleteFragmentSet,
  recordMessage,
  recordPacketReceived,
  recordPacketSent,
  recordPeerConnected,
  recordPeerDisconnected,
  recordPeerResolved,
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

  test('rotation counts UTF-8 bytes, not UTF-16 code units', () => {
    // 1.5M e-acute chars are 1.5M code units but 3M UTF-8 bytes, so
    // the 2MB byte cap drops the line; a code-unit count would keep it.
    expect(rotateDiagnosticsLogLines(['é'.repeat(1_500_000)])).toEqual([]);
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

  test('flushComplete waits for the in-flight flush and its dirty re-flush', async () => {
    let resolveFirstWrite!: () => void;
    let writeCalls = 0;
    const port: DiagnosticsLogFilePort & { content: string } = {
      content: '',
      read: async () => (port.content.length > 0 ? port.content : null),
      write: (content: string) => {
        writeCalls += 1;
        if (writeCalls === 1) {
          return new Promise<void>((resolve) => {
            resolveFirstWrite = resolve;
          });
        }
        port.content = content;
        return Promise.resolve();
      },
    };
    const writer = new DiagnosticsLogWriter(port);
    await writer.load();
    writer.append('2026-10-27T00:00:00.000Z app started');
    // This lands while the first write is in flight, so it only marks
    // the buffer dirty. A plain flush() here would return at once and
    // the shared file would still miss this line.
    writer.append('2026-10-27T00:00:01.000Z scan started');
    const complete = writer.flushComplete();
    resolveFirstWrite();
    await complete;
    expect(port.content).toContain('app started');
    expect(port.content).toContain('scan started');
  });

  test('flushed line count only moves on a successful flush', async () => {
    let failWrites = false;
    const port: DiagnosticsLogFilePort & { content: string } = {
      content: '2026-10-27T00:00:00.000Z app started\n',
      read: async () => (port.content.length > 0 ? port.content : null),
      write: async (content: string) => {
        if (failWrites) throw new Error('no storage');
        port.content = content;
      },
    };
    const writer = new DiagnosticsLogWriter(port);
    await writer.load();
    expect(writer.getFlushedLineCount()).toBe(0);
    writer.append('2026-10-27T00:00:01.000Z scan started');
    await writer.flushComplete();
    expect(writer.getFlushedLineCount()).toBe(2);
    failWrites = true;
    writer.append('2026-10-27T00:00:02.000Z adapter on');
    await writer.flushComplete();
    expect(writer.getLineCount()).toBe(3);
    expect(writer.getFlushedLineCount()).toBe(2);
    expect(writer.getLastWriteStatus().ok).toBe(false);
  });

  test('flush after a failed load writes nothing and keeps lines in memory', async () => {
    let writes = 0;
    const port: DiagnosticsLogFilePort = {
      read: async () => {
        throw new Error('no storage');
      },
      write: async () => {
        writes += 1;
      },
    };
    const writer = new DiagnosticsLogWriter(port);
    await writer.load();
    expect(writer.getLoadOk()).toBe(false);
    writer.append('2026-10-27T00:00:00.000Z app started');
    await writer.flush();
    expect(writes).toBe(0);
    expect(writer.getLineCount()).toBe(1);
    expect(writer.getLastWriteStatus().ok).toBeNull();
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
    const port = memoryPort(
      '2026-10-27T00:00:00.000Z app started\n2026-10-27T00:00:01.000Z scan started\n2026-10-27T00:00:02.000Z adapter on\n',
    );
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
    // A flush after a failed load is a no-op: writing the in-memory
    // lines over the file could destroy surviving history, so the
    // write status stays pending instead of recording a failure.
    expect(failingWriter.getLineCount()).toBe(1);
    expect(failingWriter.getLastWriteStatus().ok).toBeNull();
  });

  test('flush during load never blanks the surviving file', async () => {
    const writes: string[] = [];
    let resolveRead!: (value: string | null) => void;
    const port: DiagnosticsLogFilePort & { content: string } = {
      content: '2026-10-27T00:00:00.000Z app started\n',
      read: () => new Promise((resolve) => {
        resolveRead = resolve;
      }),
      write: async (content: string) => {
        writes.push(content);
        port.content = content;
      },
    };
    const writer = new DiagnosticsLogWriter(port);
    const loading = writer.load();
    // A flush requested inside the load window must not write the
    // still-empty line list over the surviving file.
    await writer.flush();
    expect(writes).toEqual([]);
    resolveRead(port.content);
    await loading;
    for (let i = 0; i < 20 && !port.content.includes('app started'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(writes.every((w) => w.length > 0)).toBe(true);
    expect(port.content).toContain('app started');
    expect(writer.getLoadedFromFileCount()).toBe(1);
  });

  test('byte count includes pending lines during load', async () => {
    let resolveRead!: (value: string | null) => void;
    const port: DiagnosticsLogFilePort & { content: string } = {
      content: '2026-10-27T00:00:00.000Z app started\n',
      read: () => new Promise((resolve) => {
        resolveRead = resolve;
      }),
      write: async (content: string) => {
        port.content = content;
      },
    };
    const writer = new DiagnosticsLogWriter(port);
    const loading = writer.load();
    const pendingLine = '2026-10-27T00:00:02.000Z app foreground';
    writer.append(pendingLine);
    expect(writer.getByteCount()).toBe(pendingLine.length + 1);
    resolveRead(port.content);
    await loading;
    const loadedLine = '2026-10-27T00:00:00.000Z app started';
    expect(writer.getByteCount()).toBe(loadedLine.length + 1 + pendingLine.length + 1);
  });

  test('load drops a partial trailing line instead of keeping it', async () => {
    const port = memoryPort(
      '2026-10-27T00:00:00.000Z app started\n2026-10-27T00:00:01.00',
    );
    const writer = new DiagnosticsLogWriter(port);
    await writer.load();
    expect(writer.getLines()).toEqual(['2026-10-27T00:00:00.000Z app started']);
    expect(writer.getLoadedFromFileCount()).toBe(1);
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

  test('a peer resolved to a full 64-char id never leaks that id to the log', async () => {
    const port = memoryPort();
    const writer = new DiagnosticsLogWriter(port);
    await writer.load();
    attachDiagnosticsLogWriter(writer);

    const fullId = 'ab'.repeat(32);
    recordPeerSeen('tag:0123456789abcdef', -60, '0123456789abcdef');
    recordPeerResolved('tag:0123456789abcdef', fullId);
    recordPeerConnected(fullId, 128, true);
    recordFragmentsSent(fullId, 3);
    recordFragmentsReceived(fullId, 2);
    recordPacketSent(fullId);
    recordPacketReceived(fullId);
    recordIncompleteFragmentSet(fullId);
    recordDedupDrop(fullId);
    recordPeerDisconnected(fullId);
    await writer.flush();

    const joined = writer.getLines().join('\n');
    expect(joined).not.toContain(fullId);
    expect(joined).not.toMatch(/[0-9a-fA-F]{64}/);
    expect(joined).toContain('connected');
    expect(joined).toContain('abababab...');
    // The snapshot still keys the peer by the full id; only the log
    // label is redacted.
    expect(joined).not.toContain('disconnected ' + fullId);
  });

  test('sink coalesces per-chunk frame lines into one summed summary line', async () => {
    const port = memoryPort();
    const writer = new DiagnosticsLogWriter(port);
    await writer.load();
    attachDiagnosticsLogWriter(writer);

    recordFragmentsReceived('tag:0123456789abcdef', 2);
    recordFragmentsReceived('tag:0123456789abcdef', 3);
    recordFragmentsReceived('tag:0123456789abcdef', 1);
    recordFragmentsSent('tag:0123456789abcdef', 4);
    await writer.flush();

    const lines = writer.getLines();
    const received = lines.filter((l) => l.includes('fragments-received'));
    const sent = lines.filter((l) => l.includes('fragments-sent'));
    expect(received).toHaveLength(1);
    expect(received[0]).toContain('fragments-received 6');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('fragments-sent 4');
    // Snapshot counters stay exact: coalescing only affects file lines.
    const peer = getDiagnosticsSnapshot().peers.find((p) => p.peerId === 'tag:0123456789abcdef');
    expect(peer?.frames.fragmentsReceived).toBe(6);
    expect(peer?.frames.fragmentsSent).toBe(4);
  });

  test('coalesced sink lines land on the trailing window without an explicit flush', async () => {
    const port = memoryPort();
    const writer = new DiagnosticsLogWriter(port);
    await writer.load();
    attachDiagnosticsLogWriter(writer);

    recordAdvertiseFailure('window test failure');
    expect(writer.getLines()).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(writer.getLines().some((l) => l.includes('window test failure'))).toBe(true);
  });
});
