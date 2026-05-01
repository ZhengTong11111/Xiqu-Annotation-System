import type { GongcheSymbol } from "../types";

type GongcheCharacterRendererProps = {
  character?: string;
  symbols: GongcheSymbol[];
  startTime: number;
  endTime: number;
};

type GongcheRenderMark = {
  kind:
    | "head-board"
    | "head-eye"
    | "middle-eye"
    | "end-eye"
    | "bottom-board"
    | "side-head-end-eye"
    | "side-middle-eye"
    | "huo"
    | "die"
    | "sou"
    | "breath"
    | "group";
  source: string;
  index: number;
};

type PositionedGongcheSymbol = {
  symbol: GongcheSymbol;
  x: number;
  y: number;
};

const pitchPattern = /^[合四上尺工六五]/u;

export function GongcheCharacterRenderer({
  character,
  symbols,
  startTime,
  endTime,
}: GongcheCharacterRendererProps) {
  void startTime;
  void endTime;

  return (
    <svg
      className="gongche-character-renderer"
      viewBox="0 0 170 120"
      role="img"
      aria-label={character ? `${character} 的工尺谱预览` : "工尺谱预览"}
    >
      {character ? (
        <text className="gongche-render-main-character" x="38" y="77">
          {character}
        </text>
      ) : null}
      {layoutGongcheSymbols(symbols).map(({ symbol, x, y }) => {
        const parsed = parseGongcheSymbolForRender(symbol);
        return (
          <g key={symbol.id} className="gongche-render-note" transform={`translate(${x} ${y}) rotate(-30)`}>
            <title>{symbol.rawText ?? `${symbol.label}${symbol.notation ?? ""}`}</title>
            <text className={parsed.parenthesized ? "gongche-render-pitch parenthesized" : "gongche-render-pitch"} x="0" y="6">
              {parsed.label}
            </text>
            {parsed.register === "high" ? (
              <text className="gongche-render-register-high" x="11" y="-15">
                +
              </text>
            ) : null}
            {parsed.register === "low" ? <path className="gongche-render-register-low" d="M 8 12 l 7 0 l 0 6" /> : null}
            {parsed.marks.map((mark) => (
              <GongcheMark key={`${symbol.id}-${mark.kind}-${mark.index}`} mark={mark} />
            ))}
          </g>
        );
      })}
    </svg>
  );
}

function GongcheMark({ mark }: { mark: GongcheRenderMark }) {
  if (mark.kind === "head-board") {
    return <path className="gongche-mark head-board" d="M -4 -16 C -1 -17 4 -17 8 -16" />;
  }
  if (mark.kind === "head-eye") {
    return <circle className="gongche-mark head-eye" cx="14" cy="-5" r="2.2" />;
  }
  if (mark.kind === "middle-eye") {
    return <circle className="gongche-mark middle-eye" cx="12" cy="-18" r="4" />;
  }
  if (mark.kind === "end-eye") {
    return <circle className="gongche-mark end-eye" cx="14" cy="4" r="2.2" />;
  }
  if (mark.kind === "bottom-board") {
    return <path className="gongche-mark bottom-board" d="M 9 16 l 14 -2" />;
  }
  if (mark.kind === "side-head-end-eye") {
    return <path className="gongche-mark side-head-end-eye" d="M 11 8 l 7 7 l 8 -8" />;
  }
  if (mark.kind === "side-middle-eye") {
    return <path className="gongche-mark side-middle-eye" d="M 18 -3 l 10 4 l -9 7 Z" />;
  }
  if (mark.kind === "huo") {
    return <path className="gongche-mark huo" d="M 12 13 c 8 5 15 2 18 -7" />;
  }
  if (mark.kind === "die") {
    return <circle className="gongche-mark die" cx="-11" cy="4" r="2.2" />;
  }
  if (mark.kind === "sou") {
    return <path className="gongche-mark sou" d="M 8 12 c 8 3 15 0 18 -7" />;
  }
  if (mark.kind === "breath") {
    return <path className="gongche-mark breath" d="M 15 10 l 8 0 l 0 8" />;
  }
  return null;
}

function layoutGongcheSymbols(symbols: GongcheSymbol[]): PositionedGongcheSymbol[] {
  const groups: GongcheSymbol[][] = [[]];
  symbols.forEach((symbol) => {
    groups[groups.length - 1].push(symbol);
    if (symbol.notation?.includes("/")) {
      groups.push([]);
    }
  });
  const visibleGroups = groups.filter((group) => group.length > 0);
  const total = symbols.length;

  return visibleGroups.flatMap((group, groupIndex) => {
    const priorCount = visibleGroups
      .slice(0, groupIndex)
      .reduce((count, item) => count + item.length, 0);
    const base = getLayoutBase(total, visibleGroups.length, groupIndex);
    return group.map((symbol, index) => {
      const globalIndex = priorCount + index;
      const parenthesisTuck = symbol.parenthesized ? { x: -5, y: -4 } : { x: 0, y: 0 };
      return {
        symbol,
        x: base.x + index * base.stepX + parenthesisTuck.x,
        y: base.y + index * base.stepY + parenthesisTuck.y + globalIndex * base.globalDrop,
      };
    });
  });
}

function getLayoutBase(total: number, groupCount: number, groupIndex: number) {
  if (total <= 1) {
    return { x: 88, y: 43, stepX: 0, stepY: 0, globalDrop: 0 };
  }
  if (total === 2) {
    return { x: 85, y: 34, stepX: 25, stepY: 20, globalDrop: 0 };
  }
  if (total === 3) {
    return groupCount > 1
      ? { x: 82 + groupIndex * 28, y: 28 + groupIndex * 17, stepX: 23, stepY: 19, globalDrop: 0 }
      : { x: 82, y: 28, stepX: 24, stepY: 20, globalDrop: 0 };
  }
  if (total === 4) {
    return { x: 82 + groupIndex * 14, y: 28 + groupIndex * 9, stepX: 21, stepY: 18, globalDrop: 0 };
  }
  return { x: 78 + groupIndex * 14, y: 26 + groupIndex * 8, stepX: 18, stepY: 15, globalDrop: 0 };
}

function parseGongcheSymbolForRender(symbol: GongcheSymbol) {
  const rawLabel = symbol.label.trim();
  const parenthesized = Boolean(symbol.parenthesized);
  const register = rawLabel.includes("+")
    ? "high"
    : rawLabel.includes("-")
      ? "low"
      : undefined;
  const labelMatch = rawLabel.match(pitchPattern);
  const label = labelMatch?.[0] ?? (rawLabel.replace(/[+\-]/g, "") || "工");
  const notation = symbol.notation ?? "";

  return {
    label,
    register,
    parenthesized,
    marks: parseGongcheMarks(notation),
  };
}

function parseGongcheMarks(notation: string): GongcheRenderMark[] {
  const marks: GongcheRenderMark[] = [];
  Array.from(notation).forEach((char, index) => {
    const kind = getGongcheRenderMarkKind(char);
    if (!kind) {
      return;
    }
    marks.push({ kind, source: char, index });
  });
  return marks;
}

function getGongcheRenderMarkKind(char: string): GongcheRenderMark["kind"] | null {
  if (char === "1") {
    return "head-board";
  }
  if (char === "2") {
    return "head-eye";
  }
  if (char === "3") {
    return "middle-eye";
  }
  if (char === "4") {
    return "end-eye";
  }
  if (char === "5") {
    return "bottom-board";
  }
  if (char === "6") {
    return "side-head-end-eye";
  }
  if (char === "7") {
    return "side-middle-eye";
  }
  if (char === "h") {
    return "huo";
  }
  if (char === "d") {
    return "die";
  }
  if (char === "s") {
    return "sou";
  }
  if (char === "c") {
    return "breath";
  }
  if (char === "/") {
    return "group";
  }
  return null;
}
