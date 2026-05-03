import type { GongcheSymbol } from "../types";

type GongcheCharacterRendererProps = {
  character?: string;
  symbols: GongcheSymbol[];
  startTime: number;
  endTime: number;
};

type ParsedGongcheRenderNote = {
  text: string;
  note?: string;
  side: boolean;
  beats: string;
  qikou?: boolean;
};

const noteNamesPinyin: Record<string, string> = {
  合: "he",
  四: "si",
  一: "one",
  上: "shang",
  尺: "che",
  工: "gong",
  凡: "fan",
  六: "liu",
  五: "wu",
  乙: "yi",
  "/": "qikou",
  h: "huoqiang",
  s: "souqiang",
  d: "dieqiang",
  c: "cuoqiang",
};

const zeroTimeNoteNames = new Set(["/", "h"]);

export function GongcheCharacterRenderer({
  character,
  symbols,
  startTime,
  endTime,
}: GongcheCharacterRendererProps) {
  void startTime;
  void endTime;

  const source = composeGongcheSource(symbols);
  const notes = parseGongcheNotesString(source);

  return (
    <div
      className="gongche-character-renderer gongche-reader-redmark"
      role="img"
      aria-label={character ? `${character} 的工尺谱预览` : "工尺谱预览"}
      title={source}
    >
      <div className="gongche-reader-cell">
        {character ? <div className="lyrics-text">{character}</div> : null}
        {notes.length > 0 ? (
          <div className={notes[0].note ? "lyrics-notes" : "lyrics-notes lyrics-notes-nonote"}>
            {notes.map((note, index) => {
              const noteClasses = [
                "lyrics-note",
                note.side ? "lyrics-side-note" : "",
                isAdjacentDieqiang(notes, index) ? "adj-dieqiang" : "",
              ].filter(Boolean).join(" ");

              return (
                <div key={`${note.text}-${index}-${note.beats}`} className={noteClasses}>
                  {note.qikou ? <i className="gcn-symbol gcn-s-qikou" aria-hidden="true" /> : null}
                  {note.note ? <i className={`gcn-symbol gcn-s-${note.note}`} aria-hidden="true" /> : null}
                  {note.beats.length > 0 ? (
                    <div className="lyrics-beats">
                      <span>
                        {Array.from(note.beats).map((beat, beatIndex) => (
                          <i
                            key={`${beat}-${beatIndex}`}
                            className={getBeatClassName(beat, beatIndex, note.beats)}
                            aria-hidden="true"
                          />
                        ))}
                      </span>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function composeGongcheSource(symbols: GongcheSymbol[]) {
  return symbols.map((symbol) => {
    const rawLabel = symbol.label.trim() || "工";
    const labelIsParenthesized = /^[（(].+[）)]$/u.test(rawLabel);
    const label = rawLabel.replace(/^[（(]/u, "").replace(/[）)]$/u, "");
    const side = symbol.parenthesized || labelIsParenthesized;
    return `${side ? `（${label}）` : label}${symbol.notation ?? ""}`;
  }).join("");
}

function parseGongcheNotesString(source: string): ParsedGongcheRenderNote[] {
  const notes: ParsedGongcheRenderNote[] = [];
  if (!source) {
    return notes;
  }

  let side = false;
  const tokens = source.split(/(?=[^0-9\-\+])/u);
  tokens.forEach((token) => {
    if (!token) {
      return;
    }
    if (token === "(" || token === "（") {
      side = true;
      return;
    }
    if (token === ")" || token === "）") {
      side = false;
      return;
    }

    const match = token.match(/^(\D)([+-]*)(\d*)/u);
    if (!match) {
      return;
    }

    const text = match[1].toLowerCase();
    const octave = match[2];
    const beats = match[3] ?? "";
    let note = noteNamesPinyin[text];

    if (text === "/") {
      for (let index = notes.length - 1; index >= 0; index -= 1) {
        const previous = notes[index];
        if (zeroTimeNoteNames.has(previous.text)) {
          continue;
        }
        previous.qikou = true;
        break;
      }
      return;
    }

    if (note && octave) {
      const octaveSuffix = octave[0] === "+" ? "h" : "l";
      note = `${note}-${octaveSuffix.repeat(octave.length)}`;
    }

    notes.push({
      text,
      note,
      side,
      beats,
    });
  });

  return notes;
}

function isAdjacentDieqiang(notes: ParsedGongcheRenderNote[], index: number) {
  const note = notes[index];
  if (note.note !== "dieqiang") {
    return false;
  }
  return notes[index - 1]?.note === "dieqiang" || notes[index + 1]?.note === "dieqiang";
}

function getBeatClassName(beat: string, index: number, beats: string) {
  const classes = ["gcn-symbol", `gcn-s-beat-${beat}`];
  if (index === 0 && beats.length >= 2 && beats[1] === "5") {
    classes.push("first-before-diban");
  }
  return classes.join(" ");
}
