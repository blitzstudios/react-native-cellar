import { useEffect, useState } from 'react';

/** One line of a JS stack or a React owner stack, at its location in the bundle. */
export interface StackFrame {
  method: string;
  file: string;
  line: number;
  column: number;
}

/** A frame at its location in the source, once Metro has symbolicated it. */
export interface SourceFrame extends StackFrame {
  /** Whether the frame is library code (node_modules, React, Cellar's own) rather than the app's. */
  library: boolean;
}

const FRAME = /^\s*at (?:(.*?) \()?(?:address at )?(\S+?):(\d+):(\d+)\)?\s*$/;

/** The frames of a stack's text; lines that aren't frames, such as an `Error` heading, are skipped. */
export function parseFrames(stack: string): StackFrame[] {
  const frames: StackFrame[] = [];
  for (const text of stack.split('\n')) {
    const match = FRAME.exec(text);
    if (match) frames.push({ method: match[1] || '(anonymous)', file: match[2], line: Number(match[3]), column: Number(match[4]) });
  }
  return frames;
}

const LIBRARY = /node_modules|\/react-native\/|react-native-cellar|rozenite|InternalBytecode/;

/** A source path without the machine's checkout around it, such as `app-mobile/src/v2/stats/screen.tsx`. */
export function shortPath(file: string): string {
  const inRepo = /\/clients\/(.*)$/.exec(file) ?? /\/(app-[^/]+\/.*)$/.exec(file);
  if (inRepo) return inRepo[1];
  const parts = file.split('/');
  return parts.slice(-3).join('/');
}

const symbolicated = new Map<string, Promise<SourceFrame[]>>();

/** Opens the frame's file at its line in the editor Metro finds (`REACT_EDITOR`, or a running one), as LogBox does. */
export function openInEditor(frame: { file: string; line: number }): void {
  fetch('/open-stack-frame', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: frame.file, lineNumber: frame.line }),
  }).catch(() => {
    /* Metro is not reachable from here, as in a test */
  });
}

/**
 * The frames at their places in the source, through Metro's `/symbolicate`, which serves this panel and so is its own
 * origin. Falls back to the bundle locations when Metro can't be reached, as in a test.
 */
export function symbolicate(stack: string): Promise<SourceFrame[]> {
  const known = symbolicated.get(stack);
  if (known) return known;
  const frames = parseFrames(stack);
  const asBundle = (): SourceFrame[] => frames.map((frame) => ({ ...frame, library: LIBRARY.test(frame.file) }));
  const request = !frames.length
    ? Promise.resolve([])
    : fetch('/symbolicate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stack: frames.map((frame) => ({ file: frame.file, lineNumber: frame.line, column: frame.column, methodName: frame.method })) }),
      })
        .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
        .then((body: { stack?: Array<{ file?: string; lineNumber?: number; column?: number; methodName?: string; collapse?: boolean }> }) =>
          (body.stack ?? []).map((frame, index) => {
            const file = frame.file ?? frames[index]?.file ?? '';
            return {
              method: frame.methodName ?? frames[index]?.method ?? '(anonymous)',
              file,
              line: frame.lineNumber ?? 0,
              column: frame.column ?? 0,
              library: !!frame.collapse || LIBRARY.test(file),
            };
          }),
        )
        .catch(asBundle);
  symbolicated.set(stack, request);
  return request;
}

/**
 * Where a report came from: the components that rendered it (a React owner stack) or the JS stack, symbolicated, with
 * the app's own frames first in weight and library frames dimmed.
 */
export function Callsite({ stack, kind }: { stack: string; kind?: 'component' | 'stack' }) {
  const [frames, setFrames] = useState<SourceFrame[]>();
  const [showLibrary, setShowLibrary] = useState(false);
  useEffect(() => {
    let live = true;
    symbolicate(stack).then((next) => live && setFrames(next));
    return () => {
      live = false;
    };
  }, [stack]);

  if (!frames) return <div className="muted">Resolving the callsite…</div>;
  if (!frames.length) return <pre className="json">{stack.trim()}</pre>;
  const appFrames = frames.filter((frame) => !frame.library);
  const shown = showLibrary ? frames : appFrames;
  const hidden = frames.length - shown.length;
  return (
    <div className="callsite">
      <div className="muted">{kind === 'component' ? 'Rendered by' : 'Called from'}</div>
      {!appFrames.length && !showLibrary ? <div className="muted">No app code on the stack</div> : null}
      <ol className="frames">
        {shown.map((frame, index) => (
          <li key={index} className={frame.library ? 'frame frame-library' : 'frame'}>
            <code className="frame-method">{frame.method}</code>
            {frame.file.startsWith('/') ? (
              <button type="button" className="frame-file link" title={`Open ${frame.file}:${frame.line} in your editor`} onClick={() => openInEditor(frame)}>
                {shortPath(frame.file)}:{frame.line}
              </button>
            ) : (
              <span className="frame-file" title={frame.file}>
                {shortPath(frame.file)}:{frame.line}
              </span>
            )}
          </li>
        ))}
      </ol>
      {hidden ? (
        <button type="button" className="link" onClick={() => setShowLibrary(!showLibrary)}>
          {showLibrary ? 'Hide library frames' : `Show ${hidden} library frame${hidden === 1 ? '' : 's'}`}
        </button>
      ) : null}
    </div>
  );
}

/** A report's numbers and names as `key value` chips, numbers grouped by thousands. */
export function ExtraChips({ extra }: { extra?: Record<string, string | number | boolean | null> }) {
  if (!extra) return null;
  const entries = Object.entries(extra);
  if (!entries.length) return null;
  return (
    <span className="extra">
      {entries.map(([key, value]) => (
        <span key={key} className="extra-chip">
          <span className="extra-key">{key}</span> {typeof value === 'number' ? value.toLocaleString('en-US') : String(value)}
        </span>
      ))}
    </span>
  );
}

/** Re-renders a component that shows a callsite once its frames resolve. */
export function useSymbolicated(stack: string | undefined): SourceFrame[] | undefined {
  const [frames, setFrames] = useState<SourceFrame[]>();
  useEffect(() => {
    if (!stack) return;
    let live = true;
    symbolicate(stack).then((next) => live && setFrames(next));
    return () => {
      live = false;
    };
  }, [stack]);
  return frames;
}
