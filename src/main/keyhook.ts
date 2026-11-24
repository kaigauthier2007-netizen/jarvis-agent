import { spawn, execFile, ChildProcessWithoutNullStreams } from 'child_process'
import { createInterface } from 'readline'
import { EventEmitter } from 'events'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'

/**
 * A ~10 MB helper that watches the keyboard (and, only during teach mode, the mouse) with Windows low-level hooks.
 * Electron's global shortcuts cannot see a key being HELD (Right Alt dictation), a modifier-only tap (Ctrl+Shift), or
 * a mouse click in another app. The hooks are event-driven: zero CPU while nothing is pressed. Keys are never blocked —
 * Esc still reaches the app you are in. Compiled once with the C# compiler that ships with Windows (no SDK needed).
 *
 * events: 'dictate-down' | 'dictate-up' | 'dictate-cancel' | 'quick-type' | 'esc' | 'click' (x, y physical px)
 */
const SOURCE = String.raw`
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

static class K {
  delegate IntPtr Proc(int n, IntPtr w, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] struct KB { public uint vk, scan, flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct PT { public int x, y; }
  [StructLayout(LayoutKind.Sequential)] struct MS { public PT pt; public uint data, flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr h; public uint m; public IntPtr w, l; public uint t; public PT p; }
  [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, Proc p, IntPtr mod, uint tid);
  [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h, int n, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr h, uint a, uint b);
  [DllImport("user32.dll")] static extern bool PostThreadMessage(uint tid, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string n);

  static Proc kp = KeyProc, mp = MouseProc;
  static IntPtr kh, mh;
  static uint tid;
  static volatile bool dictate = true, quick = true;
  static bool raltDown, raltOther, ctrl, shift, csArmed, csOther;
  static long csAt;
  static readonly object outLock = new object();

  static void Emit(string s) { lock (outLock) { Console.Out.WriteLine(s); Console.Out.Flush(); } }

  static IntPtr KeyProc(int n, IntPtr w, IntPtr l) {
    if (n >= 0) {
      var k = (KB)Marshal.PtrToStructure(l, typeof(KB));
      int msg = (int)w;
      bool down = msg == 0x100 || msg == 0x104, up = msg == 0x101 || msg == 0x105;
      bool injected = (k.flags & 0x10) != 0;
      uint vk = k.vk;
      if (!injected) {
        if (vk == 0xA5 && dictate) {
          if (down && !raltDown) { raltDown = true; raltOther = false; Emit("dictate-down"); }
          else if (up && raltDown) {
            raltDown = false;
            // a lone Alt tap would open the app's menu bar: slip in an unassigned key first (what AutoHotkey does)
            if (!raltOther) { keybd_event(0xE8, 0, 0, IntPtr.Zero); keybd_event(0xE8, 0, 2, IntPtr.Zero); }
            Emit(raltOther ? "dictate-cancel" : "dictate-up");
          }
        } else if (down && raltDown && !raltOther) { raltOther = true; Emit("dictate-cancel"); }

        bool isCtrl = vk == 0xA2 || vk == 0xA3 || vk == 0x11, isShift = vk == 0xA0 || vk == 0xA1 || vk == 0x10;
        if (isCtrl) { if (down) ctrl = true; if (up) ctrl = false; }
        if (isShift) { if (down) shift = true; if (up) shift = false; }
        if (down && !isCtrl && !isShift) csOther = true;
        if (down && ctrl && shift && !csArmed) { csArmed = true; csOther = false; csAt = Environment.TickCount; }
        if (up && csArmed && !ctrl && !shift) {
          csArmed = false;
          if (quick && !csOther && Environment.TickCount - csAt < 700) Emit("quick-type");
        }
        if (down && vk == 0x1B) Emit("esc");
      }
    }
    return CallNextHookEx(kh, n, w, l);
  }

  static IntPtr MouseProc(int n, IntPtr w, IntPtr l) {
    if (n >= 0 && (int)w == 0x201) {
      var m = (MS)Marshal.PtrToStructure(l, typeof(MS));
      if ((m.flags & 1) == 0) Emit("click " + m.pt.x + " " + m.pt.y);
    }
    return CallNextHookEx(mh, n, w, l);
  }

  static void Main() {
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { try { SetProcessDPIAware(); } catch { } }
    tid = GetCurrentThreadId();
    var mod = GetModuleHandle(Process.GetCurrentProcess().MainModule.ModuleName);
    kh = SetWindowsHookEx(13, kp, mod, 0);
    Emit(kh == IntPtr.Zero ? "error keyboard hook" : "ready");
    new Thread(() => {
      string line;
      while ((line = Console.In.ReadLine()) != null) {
        if (line == "mouse on") PostThreadMessage(tid, 0x8001, IntPtr.Zero, IntPtr.Zero);
        else if (line == "mouse off") PostThreadMessage(tid, 0x8002, IntPtr.Zero, IntPtr.Zero);
        else if (line == "dictate on") dictate = true;
        else if (line == "dictate off") { dictate = false; raltDown = false; }
        else if (line == "quick on") quick = true;
        else if (line == "quick off") quick = false;
      }
      Environment.Exit(0); // Jarvis closed: never linger
    }) { IsBackground = true }.Start();
    MSG msg;
    while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) {
      if (msg.m == 0x8001 && mh == IntPtr.Zero) mh = SetWindowsHookEx(14, mp, mod, 0);
      else if (msg.m == 0x8002 && mh != IntPtr.Zero) { UnhookWindowsHookEx(mh); mh = IntPtr.Zero; }
    }
  }
}
`

export const HOOK_SOURCE = SOURCE

function csc(): string | null {
  const win = process.env.WINDIR || 'C:\\Windows'
  for (const fw of ['Framework64', 'Framework']) {
    const p = join(win, 'Microsoft.NET', fw, 'v4.0.30319', 'csc.exe')
    if (existsSync(p)) return p
  }
  return null
}

export class KeyHook extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null
  private stopped = false
  ok = false
  private mouseUsers = 0

  constructor(private dir: string) {
    super()
  }

  /** Build (first run, or when the source changes) and start the helper. Resolves false when unavailable. */
  async start(opts: { dictate: boolean; quick: boolean }): Promise<boolean> {
    if (process.platform !== 'win32') return false
    try {
      const exe = await this.build()
      if (!exe || this.stopped) return false
      this.launch(exe, opts)
      return true
    } catch (e: any) {
      console.warn('[keyhook] unavailable:', e?.message || e)
      return false
    }
  }

  private async build(): Promise<string | null> {
    const hash = createHash('sha1').update(SOURCE).digest('hex').slice(0, 10)
    const bin = join(this.dir, 'bin')
    const exe = join(bin, `jarvis-keys-${hash}.exe`)
    if (existsSync(exe)) return exe
    const compiler = csc()
    if (!compiler) return null
    mkdirSync(bin, { recursive: true })
    const src = join(bin, 'jarvis-keys.cs')
    if (!existsSync(src) || readFileSync(src, 'utf8') !== SOURCE) writeFileSync(src, SOURCE)
    await new Promise<void>((resolve, reject) =>
      execFile(compiler, ['/nologo', '/optimize+', '/target:winexe', `/out:${exe}`, src], { windowsHide: true, timeout: 60_000 }, (e, out) => (e ? reject(new Error(String(out || e.message).slice(0, 400))) : resolve()))
    )
    return existsSync(exe) ? exe : null
  }

  private launch(exe: string, opts: { dictate: boolean; quick: boolean }) {
    const p = spawn(exe, [], { windowsHide: true })
    this.proc = p
    createInterface({ input: p.stdout }).on('line', (line) => {
      const l = line.trim()
      if (l === 'ready') {
        this.ok = true
        this.set(opts)
        if (this.mouseUsers > 0) this.send('mouse on')
        return
      }
      if (l.startsWith('click ')) {
        const [, x, y] = l.split(' ')
        return this.emit('click', Number(x), Number(y))
      }
      if (l.startsWith('error')) console.warn('[keyhook]', l)
      else this.emit(l)
    })
    p.on('exit', () => {
      this.ok = false
      this.proc = null
      // crashed (or killed by antivirus): try again a little later, never in a tight loop
      if (!this.stopped) setTimeout(() => !this.stopped && this.launch(exe, opts), 5000)
    })
  }

  private send(cmd: string) {
    try {
      this.proc?.stdin.write(cmd + '\n')
    } catch {}
  }

  set(opts: { dictate: boolean; quick: boolean }) {
    this.send(opts.dictate ? 'dictate on' : 'dictate off')
    this.send(opts.quick ? 'quick on' : 'quick off')
  }

  /** Report mouse clicks until the returned function is called (the mouse hook only exists while someone listens). */
  watchClicks(cb: (x: number, y: number) => void): () => void {
    this.on('click', cb)
    if (++this.mouseUsers === 1) this.send('mouse on')
    let done = false
    return () => {
      if (done) return
      done = true
      this.off('click', cb)
      if (--this.mouseUsers === 0) this.send('mouse off')
    }
  }

  stop() {
    this.stopped = true
    try {
      this.proc?.stdin.end()
      this.proc?.kill()
    } catch {}
    this.proc = null
  }
}
