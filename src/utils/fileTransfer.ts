import {
  FileTransferStartPayload,
  FileTransferChunkPayload,
  FileTransferCompletePayload,
  FileTransferCancelPayload,
  RemoteControlPacket,
} from '../types/remoteControl';
import { tauriSaveFile } from './tauriBridge';

export const DEFAULT_CHUNK_SIZE = 32 * 1024; // 32 KB per chunk for optimal WebRTC buffer throughput
export const MAX_BUFFERED_AMOUNT = 256 * 1024; // 256 KB threshold for backpressure throttling

export interface ActiveFileTransfer {
  transferId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  direction: 'upload' | 'download';
  chunksProcessed: number;
  totalChunks: number;
  progressPercent: number;
  speedMBps: number;
  status: 'pending' | 'transferring' | 'completed' | 'cancelled' | 'error';
  error?: string;
  startTime: number;
  endTime?: number;
  downloadUrl?: string;
  receivedChunks?: ArrayBuffer[];
}

export class FileTransferManager {
  private activeTransfers: Map<string, ActiveFileTransfer> = new Map();
  private onTransferUpdate?: (transfers: ActiveFileTransfer[]) => void;
  private sendPacketFn?: (packet: RemoteControlPacket) => boolean;
  private getDataChannelBufferedAmount?: () => number;

  constructor(
    sendPacketFn?: (packet: RemoteControlPacket) => boolean,
    getDataChannelBufferedAmount?: () => number,
    onTransferUpdate?: (transfers: ActiveFileTransfer[]) => void
  ) {
    this.sendPacketFn = sendPacketFn;
    this.getDataChannelBufferedAmount = getDataChannelBufferedAmount;
    this.onTransferUpdate = onTransferUpdate;
  }

  public setCallbacks(
    sendPacketFn: (packet: RemoteControlPacket) => boolean,
    getDataChannelBufferedAmount: () => number,
    onTransferUpdate: (transfers: ActiveFileTransfer[]) => void
  ) {
    this.sendPacketFn = sendPacketFn;
    this.getDataChannelBufferedAmount = getDataChannelBufferedAmount;
    this.onTransferUpdate = onTransferUpdate;
  }

  private notify() {
    if (this.onTransferUpdate) {
      this.onTransferUpdate(Array.from(this.activeTransfers.values()));
    }
  }

  // Convert ArrayBuffer to Base64 String
  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  }

  // Convert Base64 String to ArrayBuffer
  private base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binaryString = window.atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  }

  // Start sending a file to the remote peer
  public async sendFile(file: File): Promise<string> {
    const transferId = `transfer_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const totalChunks = Math.ceil(file.size / DEFAULT_CHUNK_SIZE);

    const transfer: ActiveFileTransfer = {
      transferId,
      fileName: file.name,
      fileSize: file.size,
      mimeType: file.type || 'application/octet-stream',
      direction: 'upload',
      chunksProcessed: 0,
      totalChunks,
      progressPercent: 0,
      speedMBps: 0,
      status: 'pending',
      startTime: Date.now(),
    };

    this.activeTransfers.set(transferId, transfer);
    this.notify();

    // 1. Send Transfer Start Metadata
    const startPayload: FileTransferStartPayload = {
      type: 'FILE_TRANSFER_START',
      transferId,
      fileName: file.name,
      fileSize: file.size,
      mimeType: file.type || 'application/octet-stream',
      totalChunks,
      chunkSize: DEFAULT_CHUNK_SIZE,
      timestamp: Date.now(),
    };

    if (this.sendPacketFn) {
      this.sendPacketFn(startPayload);
    }

    transfer.status = 'transferring';
    this.notify();

    // 2. Read and Stream Chunks with Backpressure Control
    this.streamFileChunks(file, transferId, totalChunks);

    return transferId;
  }

  private async streamFileChunks(file: File, transferId: string, totalChunks: number) {
    let offset = 0;
    let chunkIndex = 0;
    const startTime = Date.now();
    let bytesSent = 0;

    while (offset < file.size) {
      const transfer = this.activeTransfers.get(transferId);
      if (!transfer || transfer.status === 'cancelled') {
        break;
      }

      // Backpressure Check: wait if WebRTC RTCDataChannel buffer is too full
      if (this.getDataChannelBufferedAmount) {
        let buffered = this.getDataChannelBufferedAmount();
        while (buffered > MAX_BUFFERED_AMOUNT) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          buffered = this.getDataChannelBufferedAmount ? this.getDataChannelBufferedAmount() : 0;
        }
      }

      const chunkBlob = file.slice(offset, offset + DEFAULT_CHUNK_SIZE);
      const arrayBuffer = await chunkBlob.arrayBuffer();
      const base64Data = this.arrayBufferToBase64(arrayBuffer);

      const chunkPayload: FileTransferChunkPayload = {
        type: 'FILE_TRANSFER_CHUNK',
        transferId,
        chunkIndex,
        data: base64Data,
        timestamp: Date.now(),
      };

      if (this.sendPacketFn) {
        this.sendPacketFn(chunkPayload);
      }

      offset += arrayBuffer.byteLength;
      bytesSent += arrayBuffer.byteLength;
      chunkIndex++;

      const elapsedSec = Math.max((Date.now() - startTime) / 1000, 0.05);
      const speedMBps = parseFloat(((bytesSent / 1024 / 1024) / elapsedSec).toFixed(2));
      const progressPercent = Math.min(100, Math.round((chunkIndex / totalChunks) * 100));

      transfer.chunksProcessed = chunkIndex;
      transfer.progressPercent = progressPercent;
      transfer.speedMBps = speedMBps;
      this.notify();

      // Yield event loop briefly
      if (chunkIndex % 4 === 0) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }

    const transfer = this.activeTransfers.get(transferId);
    if (transfer && transfer.status === 'transferring') {
      transfer.status = 'completed';
      transfer.endTime = Date.now();
      transfer.progressPercent = 100;
      this.notify();

      const completePayload: FileTransferCompletePayload = {
        type: 'FILE_TRANSFER_COMPLETE',
        transferId,
        fileName: file.name,
        fileSize: file.size,
        timestamp: Date.now(),
      };
      if (this.sendPacketFn) {
        this.sendPacketFn(completePayload);
      }
    }
  }

  // Handle incoming remote packets (Start, Chunk, Complete, Cancel)
  public handleIncomingPacket(packet: RemoteControlPacket): boolean {
    if (packet.type === 'FILE_TRANSFER_START') {
      const p = packet as FileTransferStartPayload;
      const transfer: ActiveFileTransfer = {
        transferId: p.transferId,
        fileName: p.fileName,
        fileSize: p.fileSize,
        mimeType: p.mimeType,
        direction: 'download',
        chunksProcessed: 0,
        totalChunks: p.totalChunks,
        progressPercent: 0,
        speedMBps: 0,
        status: 'transferring',
        startTime: Date.now(),
        receivedChunks: new Array(p.totalChunks),
      };
      this.activeTransfers.set(p.transferId, transfer);
      this.notify();
      return true;
    }

    if (packet.type === 'FILE_TRANSFER_CHUNK') {
      const p = packet as FileTransferChunkPayload;
      const transfer = this.activeTransfers.get(p.transferId);
      if (transfer && transfer.receivedChunks) {
        const buffer = this.base64ToArrayBuffer(p.data);
        transfer.receivedChunks[p.chunkIndex] = buffer;
        transfer.chunksProcessed += 1;

        const elapsedSec = Math.max((Date.now() - transfer.startTime) / 1000, 0.05);
        const bytesReceivedSoFar = transfer.chunksProcessed * DEFAULT_CHUNK_SIZE;
        transfer.speedMBps = parseFloat(((bytesReceivedSoFar / 1024 / 1024) / elapsedSec).toFixed(2));
        transfer.progressPercent = Math.min(100, Math.round((transfer.chunksProcessed / transfer.totalChunks) * 100));

        this.notify();
        return true;
      }
    }

    if (packet.type === 'FILE_TRANSFER_COMPLETE') {
      const p = packet as FileTransferCompletePayload;
      const transfer = this.activeTransfers.get(p.transferId);
      if (transfer && transfer.receivedChunks) {
        // Assemble Blob from received chunks
        const blob = new Blob(transfer.receivedChunks, { type: transfer.mimeType });
        const downloadUrl = URL.createObjectURL(blob);

        transfer.status = 'completed';
        transfer.downloadUrl = downloadUrl;
        transfer.endTime = Date.now();
        transfer.progressPercent = 100;
        delete transfer.receivedChunks; // Free memory

        this.notify();

        // In the desktop app, offer a real save dialog: a webview blob download
        // is unreliable there. The download URL above stays as the fallback.
        blob.arrayBuffer().then((buf) => {
          void tauriSaveFile(transfer.fileName, buf);
        });
        return true;
      }
    }

    if (packet.type === 'FILE_TRANSFER_CANCEL') {
      const p = packet as FileTransferCancelPayload;
      const transfer = this.activeTransfers.get(p.transferId);
      if (transfer) {
        transfer.status = 'cancelled';
        transfer.error = p.reason || 'Cancelled by peer';
        delete transfer.receivedChunks;
        this.notify();
        return true;
      }
    }

    return false;
  }

  // Cancel an in-progress transfer
  public cancelTransfer(transferId: string, reason?: string) {
    const transfer = this.activeTransfers.get(transferId);
    if (transfer) {
      transfer.status = 'cancelled';
      transfer.error = reason || 'Cancelled by user';
      delete transfer.receivedChunks;
      this.notify();

      const cancelPayload: FileTransferCancelPayload = {
        type: 'FILE_TRANSFER_CANCEL',
        transferId,
        reason: reason || 'Cancelled by user',
        timestamp: Date.now(),
      };
      if (this.sendPacketFn) {
        this.sendPacketFn(cancelPayload);
      }
    }
  }

  // Clear completed or cancelled transfers from the list
  public clearCompleted() {
    for (const [id, transfer] of this.activeTransfers.entries()) {
      if (transfer.status === 'completed' || transfer.status === 'cancelled') {
        if (transfer.downloadUrl) {
          // keep or revoke
        }
        this.activeTransfers.delete(id);
      }
    }
    this.notify();
  }

  public getTransfers(): ActiveFileTransfer[] {
    return Array.from(this.activeTransfers.values());
  }
}
