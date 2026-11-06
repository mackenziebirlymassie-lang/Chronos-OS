/**
 * ChronosOS - Slab & Buddy Dynamic Memory Allocator Simulator
 * High-performance heap allocation with slab caching, freelist recycling, and leak tracking
 */

import { KernelMMU } from './mmu.js';
import { PageFlag, SystemConstants, KernelEvent } from '../core/types.js';
import { DOMBus } from '../core/event-bus.js';

export class SlabAllocator {
  constructor(mmu = KernelMMU) {
    this.mmu = mmu;
    this.slabSizes = [16, 32, 64, 128, 256, 512, 1024];

    // Global slab pools metadata: Map<slabSize, Array<{ frameIndex, freeSlots: [], totalSlots }>>
    this.slabPools = new Map();
    for (const size of this.slabSizes) {
      this.slabPools.set(size, []);
    }

    // Process dynamic heap tracking:
    // Map<pid, { baseVirtualAddress, currentBreak, freeLists: Map<slabSize, Array<ptr>>, allocations: Map<ptr, meta> }>
    this.processHeaps = new Map();

    this.metrics = {
      totalAllocations: 0,
      totalFrees: 0,
      activeAllocationsCount: 0,
      activeAllocatedBytes: 0,
      internalFragmentationBytes: 0,
      recycledAllocations: 0,
    };
  }

  /**
   * Ensure a virtual page is mapped into physical memory for a process
   * @private
   * @param {number} pid - Process ID
   * @param {number} vPage - Virtual Page Number
   * @returns {number} Physical Frame Index or -1 if OOM
   */
  _ensurePageMapped(pid, vPage) {
    const pageTable = this.mmu.processPageTables.get(pid);
    if (pageTable && pageTable.has(vPage)) {
      const entry = pageTable.get(vPage);
      if (entry && (entry.flags & PageFlag.PRESENT)) {
        return entry.frameIndex;
      }
    }

    const frame = this.mmu.allocatePhysicalFrame();
    if (frame !== -1) {
      this.mmu.mapPage(pid, vPage, frame, PageFlag.PRESENT | PageFlag.WRITABLE | PageFlag.USER);
    }
    return frame;
  }

  /**
   * Initialize a virtual heap region for a process (starts at 0x10000000 / 256MB)
   */
  initProcessHeap(pid, initialPages = 4) {
    const heapBase = 0x10000000;
    const freeLists = new Map();
    for (const size of this.slabSizes) {
      freeLists.set(size, []);
    }

    const heapInfo = {
      baseVirtualAddress: heapBase,
      currentBreak: heapBase,
      freeLists,
      allocations: new Map(), // ptr -> { ptr, requestedSize, allocatedSize, slabSize, allocatedFrames, timestamp, tag }
    };

    this.processHeaps.set(pid, heapInfo);

    // Map initial physical pages into process virtual memory space
    for (let i = 0; i < initialPages; i++) {
      const vPage = Math.floor((heapBase + (i * this.mmu.pageSize)) / this.mmu.pageSize);
      this._ensurePageMapped(pid, vPage);
    }

    return heapInfo;
  }

  /**
   * Allocate dynamically sized memory block with freelist slot reuse
   * @param {number} pid - Process ID
   * @param {number} sizeBytes - Requested allocation size
   * @param {string} tag - Debug tracking tag
   * @returns {number} Virtual memory pointer, or 0 if allocation failed
   */
  malloc(pid, sizeBytes, tag = 'anonymous') {
    if (sizeBytes <= 0) return 0;

    let heap = this.processHeaps.get(pid);
    if (!heap) {
      heap = this.initProcessHeap(pid);
    }

    // Determine if request fits into a slab class or requires large page allocation
    const matchingSlabSize = this.slabSizes.find(s => s >= sizeBytes);

    let virtualPointer = 0;
    let actualAllocatedSize = 0;
    let allocatedFrames = null;

    if (matchingSlabSize) {
      // Slab Allocation
      actualAllocatedSize = matchingSlabSize;
      const freeList = heap.freeLists.get(matchingSlabSize);

      if (freeList && freeList.length > 0) {
        // Reuse recycled slab slot from freelist
        virtualPointer = freeList.pop();
        this.metrics.recycledAllocations++;
      } else {
        // Carve a fresh 4KB page into slab slots
        const pageVAddr = heap.currentBreak;
        const vPage = Math.floor(pageVAddr / this.mmu.pageSize);
        const frame = this._ensurePageMapped(pid, vPage);

        if (frame === -1) {
          DOMBus.publish(KernelEvent.MEMORY_PRESSURE, { pid, sizeBytes });
          return 0; // Out of memory
        }

        virtualPointer = pageVAddr;
        heap.currentBreak += this.mmu.pageSize;

        // Populate freelist with remaining slots on this newly carved page
        const slotsCount = Math.floor(this.mmu.pageSize / matchingSlabSize);
        for (let i = 1; i < slotsCount; i++) {
          freeList.push(pageVAddr + (i * matchingSlabSize));
        }
      }

      this.metrics.internalFragmentationBytes += (matchingSlabSize - sizeBytes);
    } else {
      // Large Allocation: Align to 4KB page boundaries
      const pagesNeeded = Math.ceil(sizeBytes / this.mmu.pageSize);
      actualAllocatedSize = pagesNeeded * this.mmu.pageSize;
      virtualPointer = heap.currentBreak;
      allocatedFrames = [];

      for (let p = 0; p < pagesNeeded; p++) {
        const vPage = Math.floor((virtualPointer + (p * this.mmu.pageSize)) / this.mmu.pageSize);
        const frame = this._ensurePageMapped(pid, vPage);
        if (frame === -1) {
          // Rollback allocated frames on failure
          for (const f of allocatedFrames) {
            this.mmu.freePhysicalFrame(f);
          }
          DOMBus.publish(KernelEvent.MEMORY_PRESSURE, { pid, sizeBytes });
          return 0; // OOM
        }
        allocatedFrames.push(frame);
      }

      heap.currentBreak += actualAllocatedSize;
      this.metrics.internalFragmentationBytes += (actualAllocatedSize - sizeBytes);
    }

    // Record allocation metadata in process heap registry
    heap.allocations.set(virtualPointer, {
      ptr: virtualPointer,
      requestedSize: sizeBytes,
      allocatedSize: actualAllocatedSize,
      slabSize: matchingSlabSize || 0,
      allocatedFrames,
      timestamp: performance.now(),
      tag,
    });

    this.metrics.totalAllocations++;
    this.metrics.activeAllocationsCount++;
    this.metrics.activeAllocatedBytes += actualAllocatedSize;

    DOMBus.publish(KernelEvent.MEMORY_ALLOCATED, {
      pid,
      ptr: virtualPointer,
      sizeBytes,
      tag,
    });

    return virtualPointer;
  }

  /**
   * Release a previously allocated memory block and recycle into freelist
   * @param {number} pid - Process ID
   * @param {number} virtualPointer - Virtual pointer to free
   * @returns {boolean} True if freed successfully
   */
  free(pid, virtualPointer) {
    const heap = this.processHeaps.get(pid);
    if (!heap || !heap.allocations.has(virtualPointer)) {
      console.warn(`[Allocator] Invalid free attempt at 0x${virtualPointer?.toString(16)} by PID ${pid}`);
      return false;
    }

    const alloc = heap.allocations.get(virtualPointer);
    heap.allocations.delete(virtualPointer);

    if (alloc.slabSize > 0) {
      // Return slab slot to freelist for instant O(1) recycling
      const freeList = heap.freeLists.get(alloc.slabSize);
      if (freeList) {
        freeList.push(virtualPointer);
      }

      // Zero out memory block in physical RAM
      const physOffset = this.mmu.translate(pid, virtualPointer, true);
      if (physOffset !== -1) {
        this.mmu.ramView.fill(0, physOffset, physOffset + alloc.allocatedSize);
      }
    } else if (alloc.allocatedFrames && alloc.allocatedFrames.length > 0) {
      // Release large allocation frames back to MMU physical frame pool
      const pageTable = this.mmu.processPageTables.get(pid);
      for (let p = 0; p < alloc.allocatedFrames.length; p++) {
        const vPage = Math.floor((virtualPointer + (p * this.mmu.pageSize)) / this.mmu.pageSize);
        if (pageTable) {
          pageTable.delete(vPage);
        }
        this.mmu.freePhysicalFrame(alloc.allocatedFrames[p]);
      }
    }

    this.metrics.totalFrees++;
    this.metrics.activeAllocationsCount--;
    this.metrics.activeAllocatedBytes -= alloc.allocatedSize;
    this.metrics.internalFragmentationBytes -= (alloc.allocatedSize - alloc.requestedSize);

    DOMBus.publish(KernelEvent.MEMORY_FREED, {
      pid,
      ptr: virtualPointer,
      freedBytes: alloc.allocatedSize,
    });

    return true;
  }

  /**
   * Reallocate memory block with new size
   */
  realloc(pid, oldPtr, newSize) {
    if (!oldPtr) return this.malloc(pid, newSize);
    if (newSize <= 0) {
      this.free(pid, oldPtr);
      return 0;
    }

    const heap = this.processHeaps.get(pid);
    if (!heap || !heap.allocations.has(oldPtr)) {
      return 0;
    }

    const oldAlloc = heap.allocations.get(oldPtr);
    if (newSize <= oldAlloc.allocatedSize) {
      // Current block is large enough
      oldAlloc.requestedSize = newSize;
      return oldPtr;
    }

    // Allocate new block and copy bytes
    const newPtr = this.malloc(pid, newSize, oldAlloc.tag);
    if (!newPtr) return 0;

    for (let i = 0; i < oldAlloc.requestedSize; i++) {
      const byte = this.mmu.readByte(pid, oldPtr + i);
      this.mmu.writeByte(pid, newPtr + i, byte);
    }

    this.free(pid, oldPtr);
    return newPtr;
  }

  /**
   * Clean up all heap structures and reclaim physical pages when a process terminates
   */
  cleanupProcess(pid) {
    const heap = this.processHeaps.get(pid);
    if (!heap) return;

    for (const [ptr, alloc] of heap.allocations.entries()) {
      if (alloc.allocatedFrames && alloc.allocatedFrames.length > 0) {
        for (const frame of alloc.allocatedFrames) {
          this.mmu.freePhysicalFrame(frame);
        }
      }
      this.metrics.activeAllocatedBytes -= alloc.allocatedSize;
      this.metrics.activeAllocationsCount--;
    }

    this.processHeaps.delete(pid);
  }

  getAllocationReport(pid) {
    const heap = this.processHeaps.get(pid);
    if (!heap) return [];
    return Array.from(heap.allocations.values());
  }
}

export const KernelAllocator = new SlabAllocator();
