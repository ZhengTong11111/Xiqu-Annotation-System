import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { CommandDefinition } from "../utils/commandCatalog";
import { searchCommands } from "../utils/commandSearch";

// 搜索面板里的一条可执行项：目录提供「是什么、在哪」，App 在运行时补上「怎么执行、当前是否开启」。
// 没有运行时的定义不会出现在这里，因此本组件不需要判断模式，也不会渲染出无效入口。
export type CommandSearchEntry = CommandDefinition & {
  checked?: boolean;
  disabledReason?: string;
  run: () => void;
};

type CommandPaletteProps = {
  entries: CommandSearchEntry[];
  onRun: (entry: CommandSearchEntry) => void;
  onClose: () => void;
};

// 顶栏「搜索」菜单的展示组件：只负责查询输入、结果渲染和键盘导航，
// 不直接改动任何编辑器状态，所有副作用都通过 entry.run 回到既有 handler。
export function CommandPalette({ entries, onRun, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  // 输入法组字状态。Safari/Firefox 对 nativeEvent.isComposing 的填充并不一致，
  // 因此与 InspectorPanel 改轨道名一样，同时维护一份显式状态兜底。
  const [isComposing, setIsComposing] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const matches = useMemo(() => searchCommands(entries, query), [entries, query]);

  // 查询变化后高亮回到第一条，避免上一次的下标停留在已经不存在的结果上。
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // 键盘上下移动时把高亮项滚进可视区，长结果列表下才不会“跳到看不见的地方”。
  useEffect(() => {
    const activeElement = listRef.current?.querySelector<HTMLElement>("[data-command-active=\"true\"]");
    activeElement?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, matches]);

  // 执行一条命令：禁用项只做提示不执行，成功执行后由外层负责关闭菜单。
  function runEntry(entry: CommandSearchEntry) {
    if (entry.disabledReason) {
      return;
    }
    onRun(entry);
  }

  // 输入框内自行处理方向键/回车/Esc，并阻止冒泡，避免与 App 的全局快捷键互相干扰。
  function handleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    // 组字未上屏时，回车和上下键属于输入法的候选词操作，搜索面板必须完全让开，
    // 否则用户在选字的过程中就会误触发某条命令。
    const composing = isComposing ||
      (event.nativeEvent as KeyboardEvent & { isComposing?: boolean }).isComposing === true;
    if (composing) {
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      event.stopPropagation();
      setActiveIndex((current) => (matches.length === 0 ? 0 : (current + 1) % matches.length));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      setActiveIndex((current) =>
        matches.length === 0 ? 0 : (current - 1 + matches.length) % matches.length,
      );
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      const entry = matches[activeIndex]?.item;
      if (entry) {
        runEntry(entry);
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  }

  return (
    <div className="command-palette">
      <input
        className="command-palette-input"
        type="search"
        autoFocus
        value={query}
        placeholder="搜索功能或设置，如「循环」「频谱」"
        aria-label="搜索功能或设置"
        onChange={(event) => setQuery(event.target.value)}
        onCompositionStart={() => setIsComposing(true)}
        onCompositionEnd={(event) => {
          setIsComposing(false);
          // 上屏后立即同步一次取值：部分浏览器的 compositionend 早于最后一次 change。
          setQuery(event.currentTarget.value);
        }}
        onKeyDown={handleKeyDown}
      />
      <div className="command-palette-results" ref={listRef} role="listbox" aria-label="搜索结果">
        {matches.length === 0 ? (
          <div className="command-palette-empty">没有匹配的功能</div>
        ) : (
          matches.map((match, index) => {
            const entry = match.item;
            // 面包屑省略最后一段，因为它已经作为结果主标题展示了一次。
            const breadcrumb = entry.path.slice(0, -1);
            return (
              <button
                key={entry.id}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                data-command-active={index === activeIndex}
                className={[
                  "command-palette-item",
                  index === activeIndex ? "is-active" : "",
                  entry.disabledReason ? "is-disabled" : "",
                ].filter(Boolean).join(" ")}
                // 面包屑已经常驻显示，只有禁用原因才值得再挂一个原生提示，避免浮层盖住结果列表。
                title={entry.disabledReason}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => runEntry(entry)}
              >
                {/* 勾选标记放在固定宽度的左槽里，避免有勾的行把标题和面包屑整体推右。 */}
                <span className="command-palette-item-check" aria-hidden="true">
                  {entry.checked ? "✓" : ""}
                </span>
                <span className="command-palette-item-label">{entry.label}</span>
                {breadcrumb.length > 0 ? (
                  <span className="command-palette-item-path">{breadcrumb.join(" › ")}</span>
                ) : null}
                {entry.disabledReason ? (
                  <span className="command-palette-item-hint">{entry.disabledReason}</span>
                ) : null}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
