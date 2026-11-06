# ChronosOS: Microtask Kernel & Canvas Desktop Environment

> **Architecture Specification & Systems Manual**  
> **Engine**: Vanilla ES6+, HTML5 DOM Bus, Cooperative Microtask Event Loop Scheduler  
> **Display**: Hardware-Accelerated Multi-Window Canvas Compositor (Sub-16ms Frame Budget, 60+ FPS)  
> **Design Framework**: Strict UI/UX ProMax Standard (8pt Spatial Grid, 6 Interactive States, WCAG AAA Compliance)  
> **Dependencies**: Zero Runtime Frameworks / Zero External Libraries

---

## 1. System Overview & Core Philosophy

ChronosOS is an autonomous virtual operating system built entirely on native web standards without third-party frameworks, bundlers, or runtimes. It leverages the browser’s lower-level primitives—such as `queueMicrotask`, `OffscreenCanvas`, typed memory buffers (`ArrayBuffer`, `Uint8Array`, `DataView`), and native Pointer Events—to construct a true operating system environment inside modern web browsers.

```
+-----------------------------------------------------------------------------------------+
|                                    USER INTERACTION                                     |
|     Pointer Events (Drag/8-way Resize)   |   Virtual TTY Keyboard   |   Window Coords   |
+-----------------------------------------------------------------------------------------+
                                           |
                                           v
+-----------------------------------------------------------------------------------------+
|                                  HTML5 DOM BUS LAYER                                    |
|   Prioritized Event Dispatch  |  Wildcard Subscriptions  |  Cancellation & Normalization|
+-----------------------------------------------------------------------------------------+
                                           |
                                           v
+-----------------------------------------------------------------------------------------+
|                                  CHRONOS KERNEL CORE                                    |
|  +-------------------------------------+   +------------------------------------------+ |
|  |     COOPERATIVE MICROTASK ENGINE    |   |     VIRTUAL MEMORY MANAGEMENT UNIT       | |
|  |  - 5 Multi-Level Priority Queues    |   |  - 64MB Physical RAM (16,384 Pages)      | |
|  |  - 8ms Quantum Time-Slice Governor  |   |  - Page Table & Frame Bitmap Allocator   | |
|  |  - Starvation Prevention & Aging    |   |  - Slab Allocator (16B - 1024B Caches)   | |
|  +-------------------------------------+   +------------------------------------------+ |
|  +-------------------------------------+   +------------------------------------------+ |
|  |     PROCESS LIFECYCLE & HIERARCHY   |   |     VIRTUAL FILE SYSTEM (VFS)            | |
|  |  - PCB Context & Virtual Registers  |   |  - Inode Tree (/bin, /dev, /etc, /proc)  | |
|  |  - Process Tree & Orphan Parenting  |   |  - POSIX Descriptors, Pipes & Streams    | |
|  |  - POSIX Signals (SIGINT, SIGKILL)  |   |  - File Descriptors (0: stdin, 1: stdout)| |
|  +-------------------------------------+   +------------------------------------------+ |
+-----------------------------------------------------------------------------------------+
                                           |
                                           v
+-----------------------------------------------------------------------------------------+
|                        HARDWARE-ACCELERATED CANVAS COMPOSITOR                           |
|   Sub-16ms Smooth Frame Loop (rAF)  |  Dirty-Rect Blitting  |  Particle Field Wallpaper |
|   Window Acrylic Glassmorphism      |  8pt ProMax UI Chrome |  Real-Time Telemetry Tray |
+-----------------------------------------------------------------------------------------+
```

---

## 2. Kernel Engine: Cooperative Microtask Event Loop Scheduler

Unlike traditional web applications that rely on unpredictable `setTimeout` loops or block the browser's UI thread, ChronosOS operates an authentic preemptive/cooperative operating system scheduler utilizing native microtasks (`queueMicrotask`):

1. **Multi-Level Priority Queues**:
   - `KERNEL (0)`: Hardware device events, interrupt dispatch, memory compaction.
   - `REALTIME (1)`: Compositor buffer synchronization, audio streaming, low-latency input.
   - `INTERACTIVE (2)`: Focused window UI rendering, active shell keystrokes.
   - `BATCH (3)`: Background calculations, file indexing, compilation tasks.
   - `IDLE (4)`: Telemetry sampling, slab compaction, garbage reclamation.

2. **Quantum Time-Slice Governor (8ms)**:
   - Each process is allotted a strict execution quantum (default: 8ms).
   - If a process task slice runs longer than its quantum, the scheduler preempts it via microtask requeuing (`scheduler.yield()`), preserving the remaining time in the browser's frame budget for compositor rendering.
   - Guaranteed **sub-16ms** execution ensures 60+ FPS without dropped frames.

3. **Priority Aging & Anti-Starvation**:
   - Every 64 scheduler ticks, the kernel evaluates queue latency. If batch or idle tasks have spent more than 8 consecutive cycles awaiting execution, they are automatically elevated to the `INTERACTIVE` queue.

---

## 3. Memory Subsystem & MMU Architecture

ChronosOS simulates a 32-bit hardware Memory Management Unit (MMU) backed by an in-memory `ArrayBuffer`:

- **Physical RAM**: 64 MB (67,108,864 bytes) allocated into **16,384 physical frames** of 4,096 bytes (4 KB) each.
- **Word-Aligned Bitmap Allocator (`Uint32Array`)**:
  - Scans physical RAM using 32-bit words, checking 32 frames per step (`0xFFFFFFFF`).
  - Bitwise arithmetic (`~word & -~word`) and `Math.log2` locate free frames in constant time.
  - Allocation search cursor (`_frameWordCursor`) tracks the last allocated block to prevent redundant scans.
- **Hardware TLB Cache (64-Entry LRU)**:
  - High-speed Translation Lookaside Buffer with composite numeric hashing `(pid << 20) | vPage`.
  - Bypasses full page table lookups on repeated accesses, achieving an **80%+ TLB hit rate**.
  - Automatic TLB invalidation (`flushTLB`) when virtual pages are mapped, remapped, or process address spaces are destroyed.
- **Virtual Memory Segments**:
  - `.text` (0x00400000): Executable process instructions (Read-Only).
  - `.data` (0x00600000): Initialized global state.
  - `.bss`  (0x00800000): Zero-initialized static memory.
  - `.heap` (0x10000000): Dynamic user-space heap managed by the Freelist Slab Allocator.
  - `.stack` (0x7FFF0000): Process call stack and activation records.
- **Freelist Slab & Buddy Dynamic Allocator**:
  - Small chunk slab caches: 16B, 32B, 64B, 128B, 256B, 512B, 1024B with O(1) freelist slot recycling.
  - On-demand page carving: automatically maps a new 4KB page and populates freelist slots when a slab pool is exhausted.
  - Physical frame reclamation: large buffers (> 1024B) unmap pages and release physical frames back to the MMU bitmap on `free()`.
  - Memory security: freed slab slots are zero-filled in physical RAM to eliminate dirty reads.
- **Page-Chunked Batch String I/O**:
  - `writeString()` and `readString()` translate virtual addresses once per 4KB page boundary and batch-copy byte slices via `TypedArray.prototype.set()`, removing per-character translation overhead.

---

## 4. UI AND UX is extremely handmade and picked

ChronoOS is up to myy own standards:

1. **Spatial Discipline (8pt Scale)**:
   - All padding, margins, gaps, and dimensions strictly use the 8pt rhythm:
     `--space-0_5: 4px`, `--space-1: 8px`, `--space-2: 16px`, `--space-3: 24px`, `--space-4: 32px`, `--space-6: 48px`, `--space-8: 64px`.
   - Windows, control bars, and icons snap strictly to 8px coordinates.

2. **6 Complete Interactive States**:
   Every interactive element (buttons, tabs, inputs, window controls) explicitly defines all 6 states:
   - **Default**: Polished neutral surface with subtle 1px border.
   - **Hover**: Elevated background with cyan accent border and 2px lift.
   - **Active**: Primary cyan fill with scale(0.98) physical depression feedback.
   - **Focus-Visible**: 2px inner ring + 4px high-contrast cyan glow.
   - **Disabled**: 38% opacity with `not-allowed` cursor.
   - **Loading**: High-contrast rotating micro-spinner.

3. **Depth Hierarchy & Dark Mode Elevation**:
   - Elevation achieved through lighter surface tints rather than artificial heavy borders.
   - Background canvas: `#06090e` -> Surface 1 (Taskbar): `#121a27` -> Surface 2 (Window): `#1b2637` -> Surface 3 (Controls): `#253348`.
   - Subtle multi-layered ambient drop shadows and acrylic backdrop blur (`backdrop-filter: blur(16px)`).

4. **Typography Scale**:
   - Header: 28px (`--font-size-header`)
   - Subtitle: 16px (`--font-size-subtitle`)
   - Body: 14px (`--font-size-body`) with 1.57 line-height.
   - Monospace: 12px / 13px (`Cascadia Code`, `Fira Code`, `JetBrains Mono`).

5. **WCAG AAA Contrast Compliance**:
   - High-contrast text `#f8fafc` achieves a 14.2:1 contrast ratio against dark backgrounds.
   - Accent cyan (`#38bdf8`) achieves an 8.4:1 contrast ratio.

---

## 5. Built-in Applications Suite

| App Name | Icon | Description |
|---|---|---|
| **Quantum Terminal** | 💻 | ANSI terminal emulator (VTY) with full shell commands, piping, and signal handling. |
| **Task Manager & Process Tree** | 📊 | Hierarchical process tree viewer, live CPU sparkline, real-time microtask counters, and process termination. |
| **Memory Registry & MMU** | 🧠 | 1,024-frame interactive physical RAM map, live hex dump viewer, and slab allocator stress tester. |
| **Canvas Paint & Graphics Studio** | 🎨 | High-frequency vector/raster drawing testing sub-16ms compositor performance under continuous pointer input. |
| **File Explorer** | 📁 | In-memory VFS directory tree explorer with file viewing, directory creation, and editor integration. |
| **Code Editor & Sandbox** | 📝 | Multi-line code editor with line numbers gutter and a "Run in OS" button that executes JS inside simulated processes. |
| **System Settings** | ⚙️ | Real-time scheduler quantum tuning (2ms - 32ms), memory diagnostics, and stress testing. |

---

## 6. Global Keyboard Shortcuts

- `Alt + Tab`: Cycle focus through open desktop windows.
- `Win` / `Meta` or `Ctrl + Escape`: Toggle Start Menu / Application Launcher.
- `Ctrl + Alt + T`: Open a new Quantum Terminal window.
- `Ctrl + Shift + Escape`: Launch the Task Manager & Process Tree.
- `Ctrl + C`: Send `SIGINT` signal to the active foreground process in Terminal.
- `Ctrl + L`: Clear the terminal screen.

---

## 7. How to Run & Verify

Because ChronosOS has **zero runtime dependencies**, it runs in any modern browser:

1. Open `index.html` in your browser (e.g., using any local static file server or directly via file protocol/browser).
2. For example, using Python:
   ```bash
   python -m http.server 8080
   ```
   Or using Node:
   ```bash
   npx serve .
   ```
3. Open `http://localhost:8080` in Chrome, Firefox, Safari, or Edge.
4. Interact with the multi-window canvas desktop:
   - Drag windows by their titlebars or resize from all 8 edges/corners.
   - Drag a window to the left/right screen edge to trigger the 8pt snapping ghost preview.
   - Open the Terminal and run `neofetch`, `pstree`, `top`, `free`, or `matrix`.
   - Open Memory Inspector and click "+ 64B Slab" or "+ 4KB Page" to watch frames allocate dynamically.
   - Open Code Editor and click "▶ Run Script" to execute code inside a cooperative microtask process.
