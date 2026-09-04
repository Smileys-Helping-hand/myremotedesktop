import { describe, it, expect, beforeAll } from 'vitest';
import { FileTransferManager } from './fileTransfer';
import type {
  FileTransferStartPayload,
  FileTransferChunkPayload,
  FileTransferCompletePayload,
} from '../types/remoteControl';

// jsdom does not implement the Blob URL registry; this app only needs a
// stand-in string that survives being handed back from getTransfers().
beforeAll(() => {
  if (typeof URL.createObjectURL !== 'function') {
    URL.createObjectURL = () => 'blob:mock-url';
  }
  // jsdom's Blob polyfill omits arrayBuffer(). FileReader is jsdom's own
  // long-stable implementation, not Node's fetch/undici stack — a first
  // attempt here went through `new Response(blob).arrayBuffer()`, which
  // worked locally on Node 24 but threw "object.stream is not a function" in
  // CI on Node 20, because that path depends on undici internals that differ
  // between Node versions. FileReader carries no such dependency.
  if (typeof Blob.prototype.arrayBuffer !== 'function') {
    Blob.prototype.arrayBuffer = function (this: Blob) {
      return new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(this);
      });
    };
  }
});

function transferId() {
  return `t_${Math.random().toString(36).slice(2)}`;
}

function start(over: Partial<FileTransferStartPayload> = {}): FileTransferStartPayload {
  return {
    type: 'FILE_TRANSFER_START',
    transferId: 'default',
    fileName: 'report.pdf',
    fileSize: 3 * 32 * 1024,
    mimeType: 'application/pdf',
    totalChunks: 3,
    chunkSize: 32 * 1024,
    timestamp: Date.now(),
    ...over,
  };
}

function chunk(over: Partial<FileTransferChunkPayload> = {}): FileTransferChunkPayload {
  return {
    type: 'FILE_TRANSFER_CHUNK',
    transferId: 'default',
    chunkIndex: 0,
    data: btoa('hello'),
    timestamp: Date.now(),
    ...over,
  };
}

function complete(over: Partial<FileTransferCompletePayload> = {}): FileTransferCompletePayload {
  return {
    type: 'FILE_TRANSFER_COMPLETE',
    transferId: 'default',
    fileName: 'report.pdf',
    fileSize: 3 * 32 * 1024,
    timestamp: Date.now(),
    ...over,
  };
}

describe('FileTransferManager — receiving', () => {
  it('accepts a well-formed transfer start', () => {
    const mgr = new FileTransferManager();
    const id = transferId();
    expect(mgr.handleIncomingPacket(start({ transferId: id }))).toBe(true);
    expect(mgr.getTransfers().find((t) => t.transferId === id)?.status).toBe('transferring');
  });

  // A malicious or buggy peer announcing an implausible totalChunks must not
  // be trusted to size an array — this is the field every later chunk's
  // index is validated against.
  it.each([0, -1, 1.5, NaN, 3_000_000])(
    'refuses a transfer start announcing totalChunks=%s',
    (totalChunks) => {
      const mgr = new FileTransferManager();
      const id = transferId();
      expect(mgr.handleIncomingPacket(start({ transferId: id, totalChunks }))).toBe(false);
      expect(mgr.getTransfers().find((t) => t.transferId === id)).toBeUndefined();
    }
  );

  it('applies a chunk within range and advances progress', () => {
    const mgr = new FileTransferManager();
    const id = transferId();
    mgr.handleIncomingPacket(start({ transferId: id, totalChunks: 4 }));
    mgr.handleIncomingPacket(chunk({ transferId: id, chunkIndex: 0 }));
    mgr.handleIncomingPacket(chunk({ transferId: id, chunkIndex: 1 }));

    const t = mgr.getTransfers().find((x) => x.transferId === id)!;
    expect(t.chunksProcessed).toBe(2);
    expect(t.progressPercent).toBe(50);
  });

  // Regression: an unchecked chunkIndex let a peer grow the backing array to
  // any index it named, rather than only the range START announced.
  it.each([-1, 1.5, 3, 999_999])(
    'drops a chunk with out-of-range index %s without counting it',
    (chunkIndex) => {
      const mgr = new FileTransferManager();
      const id = transferId();
      mgr.handleIncomingPacket(start({ transferId: id, totalChunks: 3 }));

      const handled = mgr.handleIncomingPacket(chunk({ transferId: id, chunkIndex }));

      // The frame is still acknowledged as handled (it named a real transfer)
      // — it is the chunk's *effect* that is refused, not the packet itself.
      expect(handled).toBe(true);
      expect(mgr.getTransfers().find((x) => x.transferId === id)?.chunksProcessed).toBe(0);
    }
  );

  it('assembles the file once every chunk has arrived', async () => {
    const mgr = new FileTransferManager();
    const id = transferId();
    mgr.handleIncomingPacket(start({ transferId: id, totalChunks: 2 }));
    mgr.handleIncomingPacket(chunk({ transferId: id, chunkIndex: 0, data: btoa('AB') }));
    mgr.handleIncomingPacket(chunk({ transferId: id, chunkIndex: 1, data: btoa('CD') }));
    mgr.handleIncomingPacket(complete({ transferId: id }));

    const t = mgr.getTransfers().find((x) => x.transferId === id)!;
    expect(t.status).toBe('completed');
    expect(t.downloadUrl).toBeTruthy();
  });

  // Regression: a missing chunk did not stop assembly — the Blob constructor
  // silently stringifies a missing array element to the literal text
  // "undefined" and splices it into the output, corrupting the file without
  // any visible error.
  it('refuses to assemble when a chunk never arrived, rather than silently corrupting the file', () => {
    const mgr = new FileTransferManager();
    const id = transferId();
    mgr.handleIncomingPacket(start({ transferId: id, totalChunks: 3 }));
    mgr.handleIncomingPacket(chunk({ transferId: id, chunkIndex: 0 }));
    // chunkIndex 1 never arrives.
    mgr.handleIncomingPacket(chunk({ transferId: id, chunkIndex: 2 }));
    mgr.handleIncomingPacket(complete({ transferId: id }));

    const t = mgr.getTransfers().find((x) => x.transferId === id)!;
    expect(t.status).toBe('error');
    expect(t.downloadUrl).toBeUndefined();
    expect(t.error).toContain('2 of 3');
  });

  it('cancellation clears buffered chunks and marks the transfer cancelled', () => {
    const mgr = new FileTransferManager();
    const id = transferId();
    mgr.handleIncomingPacket(start({ transferId: id, totalChunks: 2 }));
    mgr.handleIncomingPacket(chunk({ transferId: id, chunkIndex: 0 }));
    mgr.handleIncomingPacket({
      type: 'FILE_TRANSFER_CANCEL',
      transferId: id,
      reason: 'peer stopped',
      timestamp: Date.now(),
    });

    const t = mgr.getTransfers().find((x) => x.transferId === id)!;
    expect(t.status).toBe('cancelled');
    expect(t.error).toBe('peer stopped');
  });

  it('ignores a chunk for a transfer nobody started', () => {
    const mgr = new FileTransferManager();
    expect(mgr.handleIncomingPacket(chunk({ transferId: 'never-started' }))).toBe(false);
  });
});
