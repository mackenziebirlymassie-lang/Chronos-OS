/**
 * ChronosOS - Memory Management Unit (MMU) & Physical RAM Simulator
 * Hardware-level virtual address translation, page tables, TLB cache, and word-aligned frame allocation
 */

import { PageFlag, SystemConstants, KernelEvent } from '../core/types.js';
import { DOMBus } from '../core/event-bus.js';

export class MMU {
  constructor(totalMemoryBytes = SystemConstants.TOTAL_MEMORY_BYTES, pageSize = SystemConstants.PAGE_SIZE_BYTES) {
    this.pageSize = pageSize;
    this.totalMemoryBytes = totalMemoryBytes;
    this.totalFrames = Math.floor(totalMemoryBytes / pageSize); // 16,384 frames for 64MB

    // Physical RAM Buffer (Typed Array backing store)
    this.ramBuffer = new ArrayBuffer(totalMemoryBytes);
    this.ramView = new Uint8Array(this.ramBuffer);
    this.dataView = new DataView(this.ramBuffer);

    // Frame allocation bitmap (1 bit per frame, 0 = Free, 1 = Allocated)
    this.frameBitmap = new Uint8Array(Math.ceil(this.totalFrames / 8));
    this.frameBitmap32 = new Uint32Array(this.frameBitmap.buffer);
    this.allocatedFramesCount = 0;
    this._frameWordCursor = 0;

    // Per-Process Page Tables: Map<pid, Map<virtualPageNum, PageTableEntry>>
    this.processPageTables = new Map();

    // Hardware Translation Lookaside Buffer (TLB) - 64-entry LRU Cache
    this.tlbCapacity = 64;
    this.tlb = new Map(); // key: (pid << 20) | vPage -> { frameIndex, flags, physBase, pageEntry }

    // MMU Telemetry & Statistics
    this.stats = {
      pageFaults: 0,
      translationsCount: 0,
      tlbHits: 0,
      tlbMisses: 0,
      writesCount: 0,
      readsCount: 0,
    };

    // Reserve first 256 frames (1MB) strictly for Kernel text and data structures
    this._reserveKernelFrames(256);
  }

  _reserveKernelFrames(count) {
    for (let frameIndex = 0; frameIndex < count; frameIndex++) {
      this._setFrameAllocated(frameIndex, true);
    }
  }

  _isFrameAllocated(frameIndex) {
    const byteIndex = frameIndex >> 3;
    const bitIndex = frameIndex & 7;
    return (this.frameBitmap[byteIndex] & (1 << bitIndex)) !== 0;
  }

  _setFrameAllocated(frameIndex, isAllocated) {
    const byteIndex = frameIndex >> 3;
    const bitIndex = frameIndex & 7;
    const wasAllocated = this._isFrameAllocated(frameIndex);

    if (isAllocated && !wasAllocated) {
      this.frameBitmap[byteIndex] |= (1 << bitIndex);
      this.allocatedFramesCount++;
    } else if (!isAllocated && wasAllocated) {
      this.frameBitmap[byteIndex] &= ~(1 << bitIndex);
      this.allocatedFramesCount--;
    }
  }

  /**
   * Allocate an available physical frame using fast 32-bit word scanning with cursor
   * @returns {number} Frame Index, or -1 if Out Of Memory (OOM)
   */
  allocatePhysicalFrame() {
    const numWords = this.frameBitmap32.length;
    const startWord = this._frameWordCursor;

    for (let attempt = 0; attempt < numWords; attempt++) {
      const wordIdx = (startWord + attempt) % numWords;
      const word = this.frameBitmap32[wordIdx];

      if (word !== 0xFFFFFFFF) {
        // Invert to find lowest zero bit
        const inverted = ~word >>> 0;
        const lowestBit = Math.log2(inverted & -inverted);
        const frameIndex = (wordIdx * 32) + lowestBit;

        if (frameIndex < this.totalFrames) {
          this._setFrameAllocated(frameIndex, true);
          this._frameWordCursor = wordIdx;

          // Zero-fill new allocated frame
          const byteStart = frameIndex * this.pageSize;
          this.ramView.fill(0, byteStart, byteStart + this.pageSize);
          return frameIndex;
        }
      }
    }

    DOMBus.publish(KernelEvent.MEMORY_PRESSURE, { allocated: this.allocatedFramesCount, total: this.totalFrames });
    return -1;
  }

  /**
   * Release a previously allocated physical frame and update search cursor
   */
  freePhysicalFrame(frameIndex) {
    if (frameIndex >= 0 && frameIndex < this.totalFrames) {
      this._setFrameAllocated(frameIndex, false);
      const wordIdx = Math.floor(frameIndex / 32);
      if (wordIdx < this._frameWordCursor) {
        this._frameWordCursor = wordIdx;
      }
    }
  }

  /**
   * Flush or invalidate TLB entries for a given process or specific page
   */
  flushTLB(pid = null, virtualPageNum = null) {
    if (pid === null) {
      this.tlb.clear();
      return;
    }

    if (virtualPageNum !== null) {
      const key = (pid << 20) | (virtualPageNum & 0xFFFFF);
      this.tlb.delete(key);
      return;
    }

    for (const [key] of this.tlb.entries()) {
      if ((key >> 20) === pid) {
        this.tlb.delete(key);
      }
    }
  }

  /**
   * Create a page directory/table for a new process
   */
  createProcessAddressSpace(pid) {
    if (!this.processPageTables.has(pid)) {
      this.processPageTables.set(pid, new Map());
    }
  }

  /**
   * Destroy an address space and release all associated physical frames
   */
  destroyProcessAddressSpace(pid) {
    const pageTable = this.processPageTables.get(pid);
    if (!pageTable) return;

    for (const [_, entry] of pageTable.entries()) {
      if (entry.flags & PageFlag.PRESENT) {
        this.freePhysicalFrame(entry.frameIndex);
      }
    }
    this.processPageTables.delete(pid);
    this.flushTLB(pid);
  }

  /**
   * Map a virtual page to a physical frame
   */
  mapPage(pid, virtualPageNum, frameIndex, flags = (PageFlag.PRESENT | PageFlag.WRITABLE | PageFlag.USER)) {
    let pageTable = this.processPageTables.get(pid);
    if (!pageTable) {
      this.createProcessAddressSpace(pid);
      pageTable = this.processPageTables.get(pid);
    }

    pageTable.set(virtualPageNum, {
      virtualPageNum,
      frameIndex,
      flags,
      allocatedAt: performance.now(),
    });

    // Invalidate stale TLB entry if mapping changed
    this.flushTLB(pid, virtualPageNum);
  }

  /**
   * Translate a process virtual address into a physical byte offset using hardware TLB cache
   * @param {number} pid - Process ID
   * @param {number} virtualAddress - Virtual memory address
   * @param {boolean} isWrite - True if operation is write
   * @returns {number} Physical byte offset in ramView
   */
  translate(pid, virtualAddress, isWrite = false) {
    this.stats.translationsCount++;
    const virtualPageNum = Math.floor(virtualAddress / this.pageSize);
    const offset = virtualAddress % this.pageSize;
    const tlbKey = (pid << 20) | (virtualPageNum & 0xFFFFF);

    let tlbEntry = this.tlb.get(tlbKey);

    if (tlbEntry) {
      this.stats.tlbHits++;
      // Refresh LRU position
      this.tlb.delete(tlbKey);
      this.tlb.set(tlbKey, tlbEntry);
    } else {
      this.stats.tlbMisses++;
      const pageTable = this.processPageTables.get(pid);
      if (!pageTable) {
        this._handlePageFault(pid, virtualAddress, 'NO_ADDRESS_SPACE');
        return -1;
      }

      const entry = pageTable.get(virtualPageNum);
      if (!entry || !(entry.flags & PageFlag.PRESENT)) {
        this._handlePageFault(pid, virtualAddress, 'PAGE_NOT_PRESENT');
        return -1;
      }

      tlbEntry = {
        frameIndex: entry.frameIndex,
        flags: entry.flags,
        physBase: entry.frameIndex * this.pageSize,
        pageEntry: entry,
      };

      // LRU Eviction if capacity exceeded
      if (this.tlb.size >= this.tlbCapacity) {
        const oldestKey = this.tlb.keys().next().value;
        this.tlb.delete(oldestKey);
      }
      this.tlb.set(tlbKey, tlbEntry);
    }

    if (isWrite && !(tlbEntry.flags & PageFlag.WRITABLE)) {
      this._handlePageFault(pid, virtualAddress, 'WRITE_PROTECTION_VIOLATION');
      return -1;
    }

    tlbEntry.flags |= PageFlag.ACCESSED;
    if (tlbEntry.pageEntry) tlbEntry.pageEntry.flags |= PageFlag.ACCESSED;

    if (isWrite) {
      tlbEntry.flags |= PageFlag.DIRTY;
      if (tlbEntry.pageEntry) tlbEntry.pageEntry.flags |= PageFlag.DIRTY;
    }

    return tlbEntry.physBase + offset;
  }

  _handlePageFault(pid, virtualAddress, reason) {
    this.stats.pageFaults++;
    DOMBus.publish(KernelEvent.MEMORY_PAGE_FAULT, { pid, virtualAddress, reason });
  }

  /**
   * Read raw byte at virtual address
   */
  readByte(pid, virtualAddress) {
    const physOffset = this.translate(pid, virtualAddress, false);
    if (physOffset === -1) return 0;
    this.stats.readsCount++;
    return this.ramView[physOffset];
  }

  /**
   * Write raw byte at virtual address
   */
  writeByte(pid, virtualAddress, byteVal) {
    const physOffset = this.translate(pid, virtualAddress, true);
    if (physOffset === -1) return false;
    this.ramView[physOffset] = byteVal & 0xFF;
    this.stats.writesCount++;
    return true;
  }

  /**
   * Write string to virtual address with page-chunked batch copy
   */
  writeString(pid, virtualAddress, str) {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(str);
    const totalBytes = bytes.length;
    let srcOffset = 0;
    let curVAddr = virtualAddress;

    while (srcOffset < totalBytes) {
      const physOffset = this.translate(pid, curVAddr, true);
      if (physOffset === -1) return srcOffset;

      const bytesInCurrentPage = this.pageSize - (curVAddr % this.pageSize);
      const chunkSize = Math.min(totalBytes - srcOffset, bytesInCurrentPage);

      this.ramView.set(bytes.subarray(srcOffset, srcOffset + chunkSize), physOffset);
      srcOffset += chunkSize;
      curVAddr += chunkSize;
    }

    this.writeByte(pid, curVAddr, 0); // null-terminator
    this.stats.writesCount += totalBytes + 1;
    return totalBytes;
  }

  /**
   * Read null-terminated string from virtual address with page-chunked scanning
   */
  readString(pid, virtualAddress, maxLen = 256) {
    const bytes = [];
    let curVAddr = virtualAddress;
    let readTotal = 0;

    while (readTotal < maxLen) {
      const physOffset = this.translate(pid, curVAddr, false);
      if (physOffset === -1) break;

      const bytesInCurrentPage = this.pageSize - (curVAddr % this.pageSize);
      const chunkSize = Math.min(maxLen - readTotal, bytesInCurrentPage);
      let foundNull = false;

      for (let i = 0; i < chunkSize; i++) {
        const val = this.ramView[physOffset + i];
        if (val === 0) {
          foundNull = true;
          break;
        }
        bytes.push(val);
      }

      readTotal += chunkSize;
      curVAddr += chunkSize;
      if (foundNull) break;
    }

    this.stats.readsCount += bytes.length;
    const decoder = new TextDecoder();
    return decoder.decode(new Uint8Array(bytes));
  }

  /**
   * Generate formatted Hex Dump representation of physical or virtual memory
   */
  getHexDump(startByte = 0, length = 128) {
    const safeStart = Math.max(0, Math.min(startByte, this.totalMemoryBytes - length));
    const lines = [];

    for (let i = 0; i < length; i += 16) {
      const offset = safeStart + i;
      const hexOffset = offset.toString(16).padStart(8, '0').toUpperCase();
      let hexBytes = '';
      let ascii = '';

      for (let j = 0; j < 16; j++) {
        const cur = offset + j;
        if (cur < this.totalMemoryBytes) {
          const val = this.ramView[cur];
          hexBytes += val.toString(16).padStart(2, '0').toUpperCase() + ' ';
          ascii += (val >= 32 && val <= 126) ? String.fromCharCode(val) : '.';
        } else {
          hexBytes += '   ';
        }
      }

      lines.push(`${hexOffset}  ${hexBytes.padEnd(48, ' ')} |${ascii}|`);
    }

    return lines.join('\n');
  }

  getMemoryUsageMetrics() {
    const usedBytes = this.allocatedFramesCount * this.pageSize;
    const freeBytes = this.totalMemoryBytes - usedBytes;
    const utilizationPct = ((usedBytes / this.totalMemoryBytes) * 100).toFixed(1);
    const totalLookups = this.stats.tlbHits + this.stats.tlbMisses;
    const tlbHitRatePct = totalLookups > 0 ? ((this.stats.tlbHits / totalLookups) * 100).toFixed(1) : '0.0';

    return {
      totalBytes: this.totalMemoryBytes,
      usedBytes,
      freeBytes,
      totalFrames: this.totalFrames,
      allocatedFrames: this.allocatedFramesCount,
      utilizationPct: parseFloat(utilizationPct),
      tlbHitRatePct: parseFloat(tlbHitRatePct),
      ...this.stats,
    };
  }
}

export const KernelMMU = new MMU();
