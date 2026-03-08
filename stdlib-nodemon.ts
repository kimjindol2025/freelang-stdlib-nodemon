/**
 * FreeLang v2 stdlib — nodemon 네이티브 구현
 *
 * npm nodemon 완전 대체 (외부 npm 0개)
 * Node.js child_process.spawn + fs.watch 기반
 *
 * 등록 함수:
 *   nodemon_spawn(script, execCmd, env)          → int (pid)
 *   nodemon_kill(pid, signal)                    → bool
 *   nodemon_is_running(pid)                      → bool
 *   nodemon_watch_start(paths, exts, ignores, delay) → int (watchId)
 *   nodemon_watch_stop(watchId)                  → void
 *   nodemon_watch_pop_event(watchId)             → string | null
 *   nodemon_watch_pending(watchId)               → bool
 *   nodemon_watch_add(watchId, path)             → void
 *   nodemon_watch_remove(watchId, path)          → void
 *   nodemon_timestamp()                          → int
 *   nodemon_format_time(ts)                      → string
 *   nodemon_sleep(ms)                            → void
 *   nodemon_stdin_enable_rs()                    → void
 *   nodemon_stdin_check_rs()                     → bool
 *   nodemon_on_event(watchId, pid, handler)      → void
 *   nodemon_on_start(watchId, handler)           → void
 *   nodemon_on_restart(watchId, handler)         → void
 *   nodemon_on_crash(pid, handler)               → void
 *   nodemon_on_quit(watchId, handler)            → void
 *   nodemon_map_get(map, key)                    → any
 */

import { NativeFunctionRegistry } from './vm/native-function-registry';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// ============================================
// 내부 상태 관리
// ============================================

interface WatchState {
  id: number;
  watchers: fs.FSWatcher[];
  events: string[];              // 변경된 파일 경로 큐
  exts: string[];
  ignores: string[];
  delayMs: number;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  onRestartCbs: Array<(file: string) => void>;
  onStartCbs: Array<() => void>;
  onQuitCbs: Array<() => void>;
  onEventCbs: Array<(evt: Record<string, unknown>) => void>;
}

interface ProcessState {
  pid: number;
  proc: cp.ChildProcess | null;
  onCrashCbs: Array<(code: number) => void>;
}

let watchCounter = 1;
const watchRegistry = new Map<number, WatchState>();
const processRegistry = new Map<number, ProcessState>();

// stdin "rs" 입력 상태
let rsPressed = false;

// ============================================
// 헬퍼
// ============================================

/** 파일/경로가 ignore 패턴에 매칭되는지 확인 */
function isIgnored(filePath: string, ignores: string[]): boolean {
  const name = path.basename(filePath);
  for (const pattern of ignores) {
    if (pattern.includes('*')) {
      // 간단한 glob: *.test.fl → /\.test\.fl$/
      const regex = new RegExp(
        '^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$'
      );
      if (regex.test(name)) return true;
    } else {
      if (filePath.includes(pattern) || name === pattern) return true;
    }
  }
  return false;
}

/** 파일 확장자 확인 */
function hasMatchingExt(filePath: string, exts: string[]): boolean {
  const ext = path.extname(filePath).replace('.', '');
  return exts.includes(ext);
}

/** 디렉토리 재귀 감시 등록 */
function watchDir(
  dirPath: string,
  state: WatchState
): void {
  try {
    const watcher = fs.watch(
      dirPath,
      { recursive: true },
      (_event, filename) => {
        if (!filename) return;

        const fullPath = path.join(dirPath, filename);

        // 확장자 필터
        if (!hasMatchingExt(fullPath, state.exts)) return;

        // ignore 필터
        if (isIgnored(fullPath, state.ignores)) return;

        // 디바운스: delay ms 안에 중복 이벤트 병합
        if (state.debounceTimer) clearTimeout(state.debounceTimer);
        state.debounceTimer = setTimeout(() => {
          state.debounceTimer = null;
          state.events.push(fullPath);

          // onRestart 콜백 호출
          for (const cb of state.onRestartCbs) {
            try { cb(fullPath); } catch (_) { /* ignore */ }
          }

          // onEvent 콜백 호출
          for (const cb of state.onEventCbs) {
            try {
              cb({ type: 'restart', file: fullPath, timestamp: Date.now(), exitCode: 0 });
            } catch (_) { /* ignore */ }
          }
        }, state.delayMs);
      }
    );
    state.watchers.push(watcher);
  } catch (_) {
    // 존재하지 않는 경로 등은 무시
  }
}

// ============================================
// 네이티브 함수 등록
// ============================================

export function registerNodemonFunctions(registry: NativeFunctionRegistry): void {

  // ──────────────────────────────────────────
  // 프로세스 관리
  // ──────────────────────────────────────────

  // nodemon_spawn(script, execCmd, env) → pid
  registry.register({
    name: 'nodemon_spawn',
    module: 'nodemon',
    executor: (args) => {
      const script  = String(args[0] || 'index.fl');
      const execCmd = String(args[1] || 'node');
      const envArg  = args[2];

      // 환경변수 병합
      const env: Record<string, string> = { ...process.env as Record<string, string> };
      if (envArg && typeof envArg === 'object') {
        if (envArg instanceof Map) {
          for (const [k, v] of envArg.entries()) {
            env[String(k)] = String(v);
          }
        } else {
          for (const [k, v] of Object.entries(envArg)) {
            env[String(k)] = String(v);
          }
        }
      }

      try {
        const child = cp.spawn(execCmd, [script], {
          env,
          stdio: 'inherit',
          shell: false,
          detached: false
        });

        const pid = child.pid ?? -1;

        // 프로세스 상태 등록
        const pState: ProcessState = {
          pid,
          proc: child,
          onCrashCbs: []
        };
        if (pid > 0) processRegistry.set(pid, pState);

        // 종료 이벤트
        child.on('exit', (code) => {
          const ps = processRegistry.get(pid);
          if (ps) {
            const exitCode = code ?? 1;
            for (const cb of ps.onCrashCbs) {
              try { cb(exitCode); } catch (_) { /* ignore */ }
            }
          }
        });

        return pid;
      } catch (e: any) {
        process.stderr.write(`[nodemon] spawn 실패: ${e.message}\n`);
        return -1;
      }
    }
  });

  // nodemon_kill(pid, signal) → bool
  registry.register({
    name: 'nodemon_kill',
    module: 'nodemon',
    executor: (args) => {
      const pid    = Number(args[0]);
      const signal = String(args[1] || 'SIGTERM') as NodeJS.Signals;

      const ps = processRegistry.get(pid);
      if (ps?.proc && !ps.proc.killed) {
        try {
          ps.proc.kill(signal);
          processRegistry.delete(pid);
          return true;
        } catch (_) {
          return false;
        }
      }

      // 직접 kill 시도 (등록 안 된 경우)
      try {
        process.kill(pid, signal);
        return true;
      } catch (_) {
        return false;
      }
    }
  });

  // nodemon_is_running(pid) → bool
  registry.register({
    name: 'nodemon_is_running',
    module: 'nodemon',
    executor: (args) => {
      const pid = Number(args[0]);
      const ps  = processRegistry.get(pid);

      if (ps?.proc) {
        return !ps.proc.killed && ps.proc.exitCode === null;
      }

      try {
        process.kill(pid, 0);  // signal 0 = 존재 확인만
        return true;
      } catch (_) {
        return false;
      }
    }
  });

  // ──────────────────────────────────────────
  // 파일 감시
  // ──────────────────────────────────────────

  // nodemon_watch_start(paths, exts, ignores, delay) → watchId
  registry.register({
    name: 'nodemon_watch_start',
    module: 'nodemon',
    executor: (args) => {
      const paths   = Array.isArray(args[0]) ? args[0].map(String) : ['.'];
      const exts    = Array.isArray(args[1]) ? args[1].map(String) : ['fl', 'free', 'ts', 'js'];
      const ignores = Array.isArray(args[2]) ? args[2].map(String) : ['node_modules'];
      const delay   = Number(args[3] ?? 500);

      const id = watchCounter++;
      const state: WatchState = {
        id,
        watchers: [],
        events: [],
        exts,
        ignores,
        delayMs: delay,
        debounceTimer: null,
        onRestartCbs: [],
        onStartCbs: [],
        onQuitCbs: [],
        onEventCbs: []
      };

      for (const p of paths) {
        watchDir(p, state);
      }

      watchRegistry.set(id, state);
      return id;
    }
  });

  // nodemon_watch_stop(watchId) → void
  registry.register({
    name: 'nodemon_watch_stop',
    module: 'nodemon',
    executor: (args) => {
      const id = Number(args[0]);
      const ws = watchRegistry.get(id);
      if (ws) {
        if (ws.debounceTimer) clearTimeout(ws.debounceTimer);
        for (const w of ws.watchers) {
          try { w.close(); } catch (_) { /* ignore */ }
        }
        watchRegistry.delete(id);
      }
      return null;
    }
  });

  // nodemon_watch_pop_event(watchId) → string | null
  registry.register({
    name: 'nodemon_watch_pop_event',
    module: 'nodemon',
    executor: (args) => {
      const id = Number(args[0]);
      const ws = watchRegistry.get(id);
      if (!ws || ws.events.length === 0) return null;
      return ws.events.shift() ?? null;
    }
  });

  // nodemon_watch_pending(watchId) → bool
  registry.register({
    name: 'nodemon_watch_pending',
    module: 'nodemon',
    executor: (args) => {
      const id = Number(args[0]);
      const ws = watchRegistry.get(id);
      return (ws?.events.length ?? 0) > 0;
    }
  });

  // nodemon_watch_add(watchId, path) → void
  registry.register({
    name: 'nodemon_watch_add',
    module: 'nodemon',
    executor: (args) => {
      const id      = Number(args[0]);
      const newPath = String(args[1]);
      const ws = watchRegistry.get(id);
      if (ws) watchDir(newPath, ws);
      return null;
    }
  });

  // nodemon_watch_remove(watchId, path) → void
  registry.register({
    name: 'nodemon_watch_remove',
    module: 'nodemon',
    executor: (args) => {
      const id       = Number(args[0]);
      const rmPath   = String(args[1]);
      const ws = watchRegistry.get(id);
      if (ws) {
        // 경로 기반 watcher 정밀 제거는 복잡 → 전체 재시작
        // 간소화: 해당 경로의 watcher만 닫기
        ws.watchers = ws.watchers.filter(w => {
          try {
            // FSWatcher에 path 접근 불가 → 모든 watcher 비교 불가
            // close 후 재등록 방식 대신 플래그 기반으로 무시 처리
            return true;
          } catch (_) { return false; }
        });
        ws.ignores.push(rmPath);  // ignore로 추가
      }
      return null;
    }
  });

  // ──────────────────────────────────────────
  // 이벤트 핸들러 등록
  // ──────────────────────────────────────────

  // nodemon_on_event(watchId, pid, handler) → void
  registry.register({
    name: 'nodemon_on_event',
    module: 'nodemon',
    executor: (args) => {
      const id      = Number(args[0]);
      const handler = args[2];
      const ws = watchRegistry.get(id);
      if (ws && typeof handler === 'function') {
        ws.onEventCbs.push(handler as (evt: Record<string, unknown>) => void);
      }
      return null;
    }
  });

  // nodemon_on_start(watchId, handler) → void
  registry.register({
    name: 'nodemon_on_start',
    module: 'nodemon',
    executor: (args) => {
      const id      = Number(args[0]);
      const handler = args[1];
      const ws = watchRegistry.get(id);
      if (ws && typeof handler === 'function') {
        ws.onStartCbs.push(handler as () => void);
        // 즉시 호출 (이미 시작됨)
        try { (handler as () => void)(); } catch (_) { /* ignore */ }
      }
      return null;
    }
  });

  // nodemon_on_restart(watchId, handler) → void
  registry.register({
    name: 'nodemon_on_restart',
    module: 'nodemon',
    executor: (args) => {
      const id      = Number(args[0]);
      const handler = args[1];
      const ws = watchRegistry.get(id);
      if (ws && typeof handler === 'function') {
        ws.onRestartCbs.push(handler as (file: string) => void);
      }
      return null;
    }
  });

  // nodemon_on_crash(pid, handler) → void
  registry.register({
    name: 'nodemon_on_crash',
    module: 'nodemon',
    executor: (args) => {
      const pid     = Number(args[0]);
      const handler = args[1];
      const ps = processRegistry.get(pid);
      if (ps && typeof handler === 'function') {
        ps.onCrashCbs.push(handler as (code: number) => void);
      }
      return null;
    }
  });

  // nodemon_on_quit(watchId, handler) → void
  registry.register({
    name: 'nodemon_on_quit',
    module: 'nodemon',
    executor: (args) => {
      const id      = Number(args[0]);
      const handler = args[1];
      const ws = watchRegistry.get(id);
      if (ws && typeof handler === 'function') {
        ws.onQuitCbs.push(handler as () => void);
      }
      return null;
    }
  });

  // ──────────────────────────────────────────
  // 유틸
  // ──────────────────────────────────────────

  // nodemon_timestamp() → int (ms)
  registry.register({
    name: 'nodemon_timestamp',
    module: 'nodemon',
    executor: (_args) => Date.now()
  });

  // nodemon_format_time(ts) → string "HH:MM:SS"
  registry.register({
    name: 'nodemon_format_time',
    module: 'nodemon',
    executor: (args) => {
      const ts = Number(args[0] || Date.now());
      const d = new Date(ts);
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      const ss = String(d.getSeconds()).padStart(2, '0');
      return `${hh}:${mm}:${ss}`;
    }
  });

  // nodemon_sleep(ms) → void (동기 블로킹 아님 — FL 루프에서 CPU 절약용)
  // 실제로는 비동기이므로 FL 이벤트 루프에서 타이밍 제어용
  registry.register({
    name: 'nodemon_sleep',
    module: 'nodemon',
    executor: (args) => {
      const ms = Number(args[0] || 10);
      // Atomics.wait로 동기 슬립 (SharedArrayBuffer 없는 환경에서는 busy-wait 대체)
      const end = Date.now() + ms;
      while (Date.now() < end) { /* busy-wait — 짧은 ms 전용 */ }
      return null;
    }
  });

  // nodemon_stdin_enable_rs() → void
  // stdin에서 "rs\n" 입력을 감지하기 위한 리스너 등록
  registry.register({
    name: 'nodemon_stdin_enable_rs',
    module: 'nodemon',
    executor: (_args) => {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode?.(false);
      }
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk: string) => {
        if (chunk.trim() === 'rs') {
          rsPressed = true;
        }
      });
      process.stdin.resume();
      return null;
    }
  });

  // nodemon_stdin_check_rs() → bool
  registry.register({
    name: 'nodemon_stdin_check_rs',
    module: 'nodemon',
    executor: (_args) => {
      if (rsPressed) {
        rsPressed = false;
        return true;
      }
      return false;
    }
  });

  // nodemon_map_get(map, key) → any
  // FL의 map/object에서 키 값 추출
  registry.register({
    name: 'nodemon_map_get',
    module: 'nodemon',
    executor: (args) => {
      const mapArg = args[0];
      const key    = String(args[1]);
      if (!mapArg) return null;
      if (mapArg instanceof Map) return mapArg.get(key) ?? null;
      if (typeof mapArg === 'object') return (mapArg as Record<string, unknown>)[key] ?? null;
      return null;
    }
  });
}
