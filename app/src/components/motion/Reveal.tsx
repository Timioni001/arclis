/**
 * Scroll-triggered reveals, and the masked word stagger.
 *
 * GSAP + ScrollTrigger drive both, because the alternative for the word
 * stagger is a hand-rolled IntersectionObserver plus a dozen transition
 * delays, and that ends up larger and worse than the library.
 *
 * Every component here degrades to *visible*, never to hidden. The failure
 * mode of a scroll animation is content nobody can read, so the rule is that
 * the final state is the default state and the animation only ever plays it
 * in. Under `prefers-reduced-motion` nothing animates at all and the content
 * is simply there.
 */

import { Fragment, useEffect, useRef, type ReactNode } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

function reducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export interface RevealProps {
  children: ReactNode;
  /** Seconds before this element starts, once it is in view. */
  delay?: number;
  /** How far it travels, in px. */
  distance?: number;
  className?: string;
  as?: "div" | "p" | "section" | "header" | "li";
}

/**
 * Fade and slide in when scrolled into view, once.
 *
 * `once` matters: an element that re-animates every time it scrolls past is a
 * distraction in an interface people are reading numbers off.
 */
export function Reveal({
  children,
  delay = 0,
  distance = 18,
  className = "",
  as: Tag = "div",
}: RevealProps) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || reducedMotion()) return;

    const ctx = gsap.context(() => {
      gsap.from(el, {
        opacity: 0,
        y: distance,
        duration: 0.8,
        delay,
        ease: "power3.out",
        scrollTrigger: {
          trigger: el,
          // Fires when the element's top reaches 88% down the viewport: far
          // enough in to feel deliberate, early enough that it has finished
          // before the reader's eye arrives.
          start: "top 88%",
          once: true,
        },
      });
    }, el);

    return () => ctx.revert();
  }, [delay, distance]);

  return (
    <Tag ref={ref as never} className={className}>
      {children}
    </Tag>
  );
}

export interface WordRevealProps {
  text: string;
  className?: string;
  /** Seconds between adjacent words. */
  stagger?: number;
  delay?: number;
  as?: "h1" | "h2" | "h3" | "p";
  /** Words to wrap in an accent span, by index. */
  accentFrom?: number;
}

/**
 * A headline whose words rise out of their own clipping masks.
 *
 * Each word gets an `overflow: hidden` wrapper and the word inside translates
 * up from below it, so the letters appear to emerge from a hard edge rather
 * than fade in place. That edge is the whole effect; without the mask it is
 * just a stagger.
 *
 * Splitting on spaces keeps whole words intact, which matters for a headline
 * that must stay readable mid-animation and for screen readers, which see the
 * full string because the wrapper carries `aria-label`.
 */
export function WordReveal({
  text,
  className = "",
  stagger = 0.06,
  delay = 0,
  as: Tag = "h1",
  accentFrom,
}: WordRevealProps) {
  const ref = useRef<HTMLElement>(null);
  const words = text.split(" ");

  useEffect(() => {
    const el = ref.current;
    if (!el || reducedMotion()) return;

    const ctx = gsap.context(() => {
      gsap.from(el.querySelectorAll(".word-inner"), {
        yPercent: 110,
        opacity: 0,
        duration: 1,
        delay,
        stagger,
        ease: "power4.out",
      });
    }, el);

    return () => ctx.revert();
  }, [delay, stagger, text]);

  return (
    <Tag
      ref={ref as never}
      className={`word-reveal ${className}`}
      aria-label={text}
    >
      {words.map((word, i) => (
        // The space is a sibling of the mask, never inside it. A mask is
        // `overflow: hidden`, so a trailing space within one is clipped and
        // the headline renders as "Fourissuers.Onepricechart."
        <Fragment key={`${word}-${i}`}>
          <span className="word-mask" aria-hidden>
            <span
              className={
                accentFrom !== undefined && i >= accentFrom
                  ? "word-inner word-accent"
                  : "word-inner"
              }
            >
              {word}
            </span>
          </span>
          {i < words.length - 1 ? <span aria-hidden> </span> : null}
        </Fragment>
      ))}
    </Tag>
  );
}

/**
 * Scrub an element's scale and position against scroll progress.
 *
 * Used for the ambient background, which shrinks and drifts as the page moves
 * so the hero feels like it has depth without anything actually parallaxing
 * the content. Content never scrubs: text that moves at a different rate to
 * its own container is how a page becomes unreadable on a trackpad.
 */
export function useScrollScrub(
  ref: React.RefObject<HTMLElement>,
  to: gsap.TweenVars,
) {
  useEffect(() => {
    const el = ref.current;
    if (!el || reducedMotion()) return;

    const ctx = gsap.context(() => {
      gsap.to(el, {
        ...to,
        ease: "none",
        scrollTrigger: {
          trigger: document.body,
          start: "top top",
          end: "+=900",
          scrub: 0.6,
        },
      });
    }, el);

    return () => ctx.revert();
    // `to` is a literal at every call site, so a deep compare would cost more
    // than it saves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref]);
}
