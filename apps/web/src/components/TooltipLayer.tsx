import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type ActiveTooltip = { target: HTMLElement; text: string };

function tooltipTarget(source: EventTarget | null): HTMLElement | null {
  if (!(source instanceof Element)) return null;
  const target = source.closest<HTMLElement>("[data-tooltip]");
  return target?.dataset.tooltip ? target : null;
}

export function TooltipLayer() {
  const [active, setActive] = useState<ActiveTooltip | null>(null);
  const targetRef = useRef<HTMLElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function clearTimer() {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    function hide() {
      clearTimer();
      targetRef.current = null;
      setActive(null);
    }

    function show(target: HTMLElement, delayed: boolean) {
      if (targetRef.current === target && delayed) return;
      clearTimer();
      targetRef.current = target;
      setActive(null);
      const reveal = () => {
        timerRef.current = null;
        if (targetRef.current === target && target.isConnected) {
          const text = target.dataset.tooltip;
          if (text) setActive({ target, text });
        }
      };
      if (delayed) timerRef.current = window.setTimeout(reveal, 450);
      else reveal();
    }

    function onPointerOver(event: PointerEvent) {
      const target = tooltipTarget(event.target);
      if (target) show(target, true);
    }

    function onPointerOut(event: PointerEvent) {
      const target = targetRef.current;
      if (target && !(event.relatedTarget instanceof Node && target.contains(event.relatedTarget))) hide();
    }

    function onFocusIn(event: FocusEvent) {
      const target = tooltipTarget(event.target);
      if (target?.matches(":focus-visible")) show(target, false);
    }

    function onFocusOut(event: FocusEvent) {
      const target = targetRef.current;
      if (target && !(event.relatedTarget instanceof Node && target.contains(event.relatedTarget))) hide();
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") hide();
    }

    document.addEventListener("pointerover", onPointerOver);
    document.addEventListener("pointerout", onPointerOut);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    document.addEventListener("pointerdown", hide);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      clearTimer();
      document.removeEventListener("pointerover", onPointerOver);
      document.removeEventListener("pointerout", onPointerOut);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("pointerdown", hide);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    const observer = new MutationObserver(() => {
      const text = active.target.dataset.tooltip;
      if (!text) setActive(null);
      else if (text !== active.text) setActive({ target: active.target, text });
    });
    observer.observe(active.target, { attributes: true, attributeFilter: ["data-tooltip"] });
    return () => observer.disconnect();
  }, [active]);

  useLayoutEffect(() => {
    const tooltip = tooltipRef.current;
    if (!active || !tooltip) return;
    const rect = active.target.getBoundingClientRect();
    const halfWidth = tooltip.offsetWidth / 2;
    const center = Math.min(
      Math.max(rect.left + rect.width / 2, halfWidth + 8),
      window.innerWidth - halfWidth - 8,
    );
    const titlebarBottom = document.querySelector<HTMLElement>("[data-app-titlebar]")
      ?.getBoundingClientRect().bottom ?? 0;
    const roomAbove = rect.top - 8 - titlebarBottom;
    const roomBelow = window.innerHeight - rect.bottom - 8;
    const above = roomAbove >= tooltip.offsetHeight ||
      (roomBelow < tooltip.offsetHeight && roomAbove > roomBelow);
    tooltip.style.left = `${center}px`;
    tooltip.style.top = `${above ? rect.top - 8 : rect.bottom + 8}px`;
    tooltip.style.transform = above ? "translate(-50%, -100%)" : "translateX(-50%)";
  }, [active]);

  return active ? createPortal(
    <div
      ref={tooltipRef}
      role="tooltip"
      className="app-tooltip pointer-events-none fixed z-[100] max-w-[min(20rem,calc(100vw-1rem))] break-words rounded-lg border border-border bg-popover px-2.5 py-1.5 text-xs leading-4 text-popover-foreground shadow-lg"
    >
      {active.text}
    </div>,
    document.body,
  ) : null;
}
