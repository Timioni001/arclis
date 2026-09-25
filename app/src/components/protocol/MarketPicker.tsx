/**
 * The market switcher on the Trade page.
 *
 * With thirty-five markets, going back to the Overview to change market was
 * the only way to change market. The symbol in the Trade header is now the
 * switcher: click it (or press "/") and type. Arrow keys move, Enter opens,
 * Escape closes, and a click outside closes it too.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MarketView } from "../../lib/protocol/types";
import { roundTheClock } from "../../lib/markets";
import { pct, usd } from "../../lib/format";
import { Delta, Icon } from "../ui";

export function MarketPicker({
  markets,
  current,
  onSelect,
}: {
  markets: MarketView[];
  current: string;
  onSelect: (symbol: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  // Where the popover sits relative to the trigger, kept 16px inside the
  // viewport on both sides whatever the trigger's position.
  const [place, setPlace] = useState({ left: -8, width: 420 });

  useLayoutEffect(() => {
    if (!open || !root.current) return;
    const r = root.current.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const width = Math.min(420, vw - 32);
    const x = Math.min(Math.max(r.left - 8, 16), vw - 16 - width);
    setPlace({ left: x - r.left, width });
  }, [open]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = markets.filter(
      (mv) =>
        !q ||
        mv.oracle.symbol.toLowerCase().includes(q) ||
        mv.oracle.name.toLowerCase().includes(q),
    );
    // Ticker matches first, then alphabetical: typing "ko" should put KO
    // above every company with "ko" somewhere in its name.
    return matches.sort((a, b) => {
      const as = a.oracle.symbol.toLowerCase().startsWith(q) ? 0 : 1;
      const bs = b.oracle.symbol.toLowerCase().startsWith(q) ? 0 : 1;
      return as - bs || a.oracle.symbol.localeCompare(b.oracle.symbol);
    });
  }, [markets, query]);

  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // "/" opens the switcher from anywhere on the Trade page, unless the user
  // is typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing =
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable);
      if (e.key === "/" && !typing) {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (symbol: string) => {
    setOpen(false);
    setQuery("");
    if (symbol !== current) onSelect(symbol);
  };

  return (
    <div className="picker" ref={root}>
      <button
        className="picker-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        title="Switch market (press /)"
      >
        <h1 className="page-title">{current}</h1>
        <Icon name="caretDown" size={18} />
      </button>

      {open && (
        <div
          className="picker-pop"
          role="dialog"
          aria-label="Switch market"
          style={{ left: place.left, width: place.width }}
        >
          <label className="picker-search">
            <Icon name="search" size={16} />
            <input
              ref={input}
              type="search"
              value={query}
              placeholder={`Search ${markets.length} markets`}
              aria-label="Search markets"
              aria-controls="picker-list"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActive((i) => Math.min(i + 1, results.length - 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActive((i) => Math.max(i - 1, 0));
                } else if (e.key === "Enter" && results[active]) {
                  e.preventDefault();
                  choose(results[active].oracle.symbol);
                } else if (e.key === "Escape") {
                  setOpen(false);
                }
              }}
            />
          </label>
          <ul
            className="picker-list"
            id="picker-list"
            role="listbox"
            ref={list}
          >
            {results.length === 0 && (
              <li className="picker-empty">No market matches “{query}”.</li>
            )}
            {results.map((mv, i) => (
              <li
                key={mv.oracle.symbol}
                role="option"
                aria-selected={mv.oracle.symbol === current}
                data-index={i}
                data-active={i === active}
                className="picker-row"
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(mv.oracle.symbol)}
              >
                <span className="picker-name">
                  <span className="picker-symbol">
                    {mv.oracle.symbol}
                    {roundTheClock(mv.oracle.symbol) && (
                      <span className="badge-lime mover-tag">24/7</span>
                    )}
                    {mv.oracle.session !== "Open" && (
                      <span className="picker-closed">
                        {mv.oracle.session === "PreOpen"
                          ? "pre-open"
                          : mv.oracle.session.toLowerCase()}
                      </span>
                    )}
                  </span>
                  <span className="picker-company">{mv.oracle.name}</span>
                </span>
                <span className="picker-price num">
                  {usd(mv.oracle.price, { compact: false })}
                  <Delta value={mv.changePct24h}>{pct(mv.changePct24h)}</Delta>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
