import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import {
  EditorState,
  Compartment,
  StateEffect,
  StateField,
  RangeSet,
  type Extension,
} from "@codemirror/state";
import {
  EditorView,
  GutterMarker,
  gutter,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  placeholder as cmPlaceholder,
  drawSelection,
  Decoration,
  type DecorationSet,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentMore,
  indentLess,
} from "@codemirror/commands";
import {
  bracketMatching,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
  HighlightStyle,
} from "@codemirror/language";
import {
  autocompletion,
  completeFromList,
  closeBrackets,
  acceptCompletion,
} from "@codemirror/autocomplete";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { linter, lintGutter } from "@codemirror/lint";
import { vim } from "@replit/codemirror-vim";
import { tags } from "@lezer/highlight";
import {
  amlLanguage,
  oasmLanguage,
  AML_COMPLETIONS,
  OASM_COMPLETIONS,
} from "src/features/contracts/components/editor/contractLanguages";
import { amlDiagnostics } from "src/features/contracts/components/editor/amlLint";
import { diffLines } from "src/features/contracts/components/editor/lineDiff";

export interface CodeEditorHandle {
  getSelection(): string;
  getSelectionRange(): { from: number; to: number };
  replaceRange(from: number, to: number, text: string): void;
  insertAtCursor(text: string): void;
  setValue(text: string): void;
  focus(): void;
  goToLine(line: number): void;
  selectRange(from: number, to: number): void;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  language: "aml" | "assembly";
  placeholder?: string;
  errorLine?: number | null;
  vimMode?: boolean;
  /** Cmd/Ctrl+I; Cmd+K stays the app's palette. */
  onInlineEdit?: () => void;
  onSelectionChange?: (selection: string) => void;
  readOnly?: boolean;
  savedText?: string | null;
  docKey?: string;
  onCursorChange?: (line: number, col: number) => void;
}

class ChangeMark extends GutterMarker {
  constructor(readonly cls: string) {
    super();
  }
  eq(other: ChangeMark) {
    return other.cls === this.cls;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = `cm-chg ${this.cls}`;
    return el;
  }
}

const setSavedText = StateEffect.define<string | null>();

function changeMarks(state: EditorState, saved: string | null): RangeSet<GutterMarker> {
  if (saved == null) return RangeSet.empty;
  const d = diffLines(saved, state.doc.toString());
  const above = new Set(d.deletedAbove);
  const last = state.doc.lines;
  const marks = [];
  for (let n = 1; n <= last; n++) {
    const cls = [
      d.marks[n - 1] ?? "",
      above.has(n) ? "dtop" : "",
      d.deletedAtEnd && n === last ? "dbot" : "",
    ]
      .filter(Boolean)
      .join(" ");
    if (cls) marks.push(new ChangeMark(cls).range(state.doc.line(n).from));
  }
  return RangeSet.of(marks);
}

const changeField = StateField.define<{ saved: string | null; marks: RangeSet<GutterMarker> }>({
  create: () => ({ saved: null, marks: RangeSet.empty }),
  update(value, tr) {
    let saved = value.saved;
    for (const e of tr.effects) if (e.is(setSavedText)) saved = e.value;
    if (saved === value.saved && !tr.docChanged) return value;
    return { saved, marks: changeMarks(tr.state, saved) };
  },
});

const changeGutter = [
  changeField,
  gutter({ class: "cm-changes", markers: (v) => v.state.field(changeField).marks }),
];

const setErrorLine = StateEffect.define<number | null>();

const errorLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setErrorLine)) {
        if (e.value == null || e.value < 1 || e.value > tr.state.doc.lines) {
          deco = Decoration.none;
        } else {
          const line = tr.state.doc.line(e.value);
          deco = Decoration.set([Decoration.line({ class: "cm-errorLine" }).range(line.from)]);
        }
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const houseTheme = EditorView.theme({
  "&": {
    // Matches the surface-card the editor sits in: bg-main reads as a black inset against it.
    // inset against the grey card.
    backgroundColor: "var(--bg-card)",
    color: "var(--text-main)",
    fontSize: "0.75rem",
    height: "100%",
  },
  ".cm-content": {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    caretColor: "var(--primary)",
    padding: "8px 0",
    lineHeight: "1.5",
  },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--primary)" },
  "&.cm-focused": { outline: "none" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "color-mix(in srgb, var(--primary) 22%, transparent)",
  },
  ".cm-activeLine": {
    backgroundColor: "color-mix(in srgb, var(--text-main) 4%, transparent)",
  },
  ".cm-gutters": {
    backgroundColor: "var(--bg-highlight)",
    color: "var(--text-muted)",
    border: "none",
    borderRight: "1px solid var(--border-color)",
    fontSize: "0.6875rem",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: "var(--text-secondary)",
  },
  ".cm-errorLine": {
    backgroundColor: "color-mix(in srgb, var(--error) 12%, transparent)",
  },
  ".cm-selectionMatch": {
    backgroundColor: "color-mix(in srgb, var(--primary) 14%, transparent)",
  },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
    backgroundColor: "color-mix(in srgb, var(--primary) 18%, transparent)",
    outline: "none",
  },
  ".cm-tooltip": {
    backgroundColor: "var(--bg-card-2)",
    border: "1px solid var(--border-color)",
    borderRadius: "8px",
    color: "var(--text-main)",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    backgroundColor: "color-mix(in srgb, var(--primary) 18%, transparent)",
    color: "var(--text-main)",
  },
  ".cm-panels": {
    backgroundColor: "var(--bg-card)",
    color: "var(--text-main)",
    borderTop: "1px solid var(--border-color)",
  },
  ".cm-textfield": {
    backgroundColor: "var(--bg-input)",
    border: "1px solid var(--border-color)",
    color: "var(--text-main)",
  },
  ".cm-button": {
    backgroundImage: "none",
    backgroundColor: "var(--bg-highlight)",
    border: "1px solid var(--border-color)",
    color: "var(--text-main)",
  },
  ".cm-placeholder": { color: "var(--text-faint)" },
  ".cm-lintRange-error": {
    backgroundImage: "none",
    borderBottom: "1.5px wavy underline var(--error)",
    textDecoration: "underline wavy var(--error) 1px",
  },
  ".cm-lintRange-warning": {
    backgroundImage: "none",
    textDecoration: "underline wavy var(--warning) 1px",
  },
  ".cm-tooltip-lint": {
    backgroundColor: "var(--bg-card-2)",
    border: "1px solid var(--border-color)",
  },
  ".cm-lint-marker-error": { content: "none" },
  ".cm-vim-panel": { color: "var(--text-main)" },
  ".cm-fat-cursor": {
    backgroundColor: "color-mix(in srgb, var(--primary) 55%, transparent) !important",
    outline: "none !important",
  },
  "&:not(.cm-focused) .cm-fat-cursor": {
    outline: "solid 1px color-mix(in srgb, var(--primary) 55%, transparent) !important",
    backgroundColor: "transparent !important",
  },
});

const highlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--syn-k, var(--primary))" },
  { tag: tags.typeName, color: "var(--syn-t, var(--warning))" },
  { tag: tags.standard(tags.variableName), color: "var(--syn-k, var(--info))" },
  { tag: tags.function(tags.variableName), color: "var(--syn-f, var(--success))" },
  { tag: tags.labelName, color: "var(--syn-f, var(--success))" },
  { tag: tags.string, color: "var(--syn-s, var(--success))" },
  { tag: tags.number, color: "var(--syn-n, var(--warning))" },
  { tag: tags.comment, color: "var(--syn-c, var(--text-muted))", fontStyle: "italic" },
  { tag: tags.operator, color: "var(--text-secondary)" },
  { tag: tags.bracket, color: "var(--text-secondary)" },
]);

const CodeEditor = forwardRef<CodeEditorHandle, Props>(function CodeEditor(
  {
    value,
    onChange,
    language,
    placeholder,
    errorLine,
    vimMode,
    onInlineEdit,
    onSelectionChange,
    readOnly,
    savedText,
    docKey,
    onCursorChange,
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const vimCompartment = useRef(new Compartment());
  const langCompartment = useRef(new Compartment());
  // Callbacks live in refs so the view is built exactly once.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onInlineEditRef = useRef(onInlineEdit);
  onInlineEditRef.current = onInlineEdit;
  const onSelectionChangeRef = useRef(onSelectionChange);
  onSelectionChangeRef.current = onSelectionChange;

  const langExtension = useMemo(
    () =>
      language === "assembly"
        ? [oasmLanguage, autocompletion({ override: [completeFromList(OASM_COMPLETIONS)] })]
        : [
            amlLanguage,
            autocompletion({ override: [completeFromList(AML_COMPLETIONS)] }),
            linter((view) => amlDiagnostics(view.state.doc.toString()), { delay: 400 }),
            lintGutter(),
          ],
    [language],
  );

  const savedRef = useRef(savedText ?? null);
  savedRef.current = savedText ?? null;
  const onCursorRef = useRef(onCursorChange);
  onCursorRef.current = onCursorChange;
  const vimRef = useRef(vimMode);
  vimRef.current = vimMode;
  const langRef = useRef(langExtension);
  langRef.current = langExtension;

  const extensions = (): Extension[] => [
    readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [],
    vimCompartment.current.of(vimRef.current ? vim() : []),
    savedText !== undefined ? changeGutter : [],
    lineNumbers(),
    history(),
    drawSelection(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    indentOnInput(),
    indentUnit.of("  "),
    bracketMatching(),
    closeBrackets(),
    highlightSelectionMatches(),
    keymap.of([
      {
        key: "Mod-i",
        run: () => {
          onInlineEditRef.current?.();
          return true;
        },
      },
      {
        // Tab accepts an open completion, indents a selection, else inserts the indent unit
        // (indentWithTab re-indents the whole line instead).
        // selection, otherwise insert the indent unit at the cursor
        // (indentWithTab re-indents the whole line instead - feels wrong).
        key: "Tab",
        run: (view) => {
          if (acceptCompletion(view)) return true;
          if (view.state.selection.ranges.some((r) => !r.empty)) return indentMore(view);
          view.dispatch(view.state.replaceSelection("  "), {
            scrollIntoView: true,
            userEvent: "input",
          });
          return true;
        },
        shift: indentLess,
      },
      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap,
    ]),
    langCompartment.current.of(langRef.current),
    houseTheme,
    syntaxHighlighting(highlightStyle),
    errorLineField,
    cmPlaceholder(placeholder ?? ""),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) onChangeRef.current(update.state.doc.toString());
      if (update.selectionSet) {
        const { from, to } = update.state.selection.main;
        onSelectionChangeRef.current?.(from === to ? "" : update.state.sliceDoc(from, to));
      }
      if (update.selectionSet || update.docChanged) {
        const head = update.state.selection.main.head;
        const line = update.state.doc.lineAt(head);
        onCursorRef.current?.(line.number, head - line.from + 1);
      }
    }),
  ];

  const freshState = (doc: string) => {
    const state = EditorState.create({ doc, extensions: extensions() });
    return savedRef.current == null
      ? state
      : state.update({ effects: setSavedText.of(savedRef.current) }).state;
  };

  // effect:audited - imperative CodeMirror lifecycle; the view is created once on mount.
  useEffect(() => {
    if (!containerRef.current) return;
    const view = new EditorView({ state: freshState(value), parent: containerRef.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const keyRef = useRef(docKey);
  // effect:audited - another file: a fresh document so undo never crosses into the last one.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || keyRef.current === docKey) return;
    keyRef.current = docKey;
    view.setState(freshState(value));
    view.dispatch({ effects: setErrorLine.of(errorLine ?? null) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey]);

  // effect:audited - the saved text moved (a save, a revert or a reload): redraw the marks.
  useEffect(() => {
    if (savedText === undefined) return;
    viewRef.current?.dispatch({ effects: setSavedText.of(savedText) });
  }, [savedText]);

  // effect:audited - push external prop changes into the imperative view.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (value !== view.state.doc.toString()) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    }
  }, [value]);

  // effect:audited - reconfigure vim mode in place.
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: vimCompartment.current.reconfigure(vimMode ? vim() : []),
    });
  }, [vimMode]);

  // effect:audited - swap language + completions when the tab's language changes.
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: langCompartment.current.reconfigure(langExtension),
    });
  }, [langExtension]);

  // effect:audited - mirror the compile error line into a line decoration.
  useEffect(() => {
    viewRef.current?.dispatch({ effects: setErrorLine.of(errorLine ?? null) });
  }, [errorLine]);

  useImperativeHandle(ref, () => ({
    getSelection() {
      const view = viewRef.current;
      if (!view) return "";
      const { from, to } = view.state.selection.main;
      return view.state.sliceDoc(from, to);
    },
    getSelectionRange() {
      const view = viewRef.current;
      if (!view) return { from: 0, to: 0 };
      const { from, to } = view.state.selection.main;
      return { from, to };
    },
    replaceRange(from, to, text) {
      viewRef.current?.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length },
      });
    },
    insertAtCursor(text) {
      const view = viewRef.current;
      if (!view) return;
      const { from, to } = view.state.selection.main;
      view.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length },
      });
    },
    setValue(text) {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    },
    focus() {
      viewRef.current?.focus();
    },
    goToLine(line) {
      const view = viewRef.current;
      if (!view) return;
      const clamped = Math.max(1, Math.min(line, view.state.doc.lines));
      const pos = view.state.doc.line(clamped).from;
      view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
      view.focus();
    },
    selectRange(from, to) {
      const view = viewRef.current;
      if (!view) return;
      const max = view.state.doc.length;
      view.dispatch({
        selection: { anchor: Math.min(from, max), head: Math.min(to, max) },
        scrollIntoView: true,
      });
      view.focus();
    },
  }));

  return <div ref={containerRef} className="h-full [&_.cm-editor]:h-full" />;
});

export default CodeEditor;
