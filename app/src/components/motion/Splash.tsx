/**
 * The opening: the wordmark alone, then the site.
 *
 * Three rules keep an intro animation from being a tax on everyone who has
 * seen it before:
 *
 *  1. **It is short, and it is skippable.** A click, a key, or a scroll ends
 *     it immediately. Nobody is held hostage by a logo.
 *  2. **It plays once per session.** `sessionStorage`, so a reload during the
 *     same visit goes straight in, but a genuinely new visit still gets the
 *     moment. A splash on every navigation is a splash people learn to resent.
 *  3. **It never blocks the app.** The interface mounts underneath it from the
 *     first frame; this is an overlay that fades, not a gate that must resolve.
 *     If the animation fails, nothing is behind a spinner.
 */

import { useEffect, useRef, useState } from "react";
import gsap from "gsap";

const SEEN_KEY = "arclis-splash-seen";

function alreadySeen(): boolean {
  try {
    return sessionStorage.getItem(SEEN_KEY) === "1";
  } catch {
    // Private browsing. Showing it again is the harmless failure.
    return false;
  }
}

function markSeen() {
  try {
    sessionStorage.setItem(SEEN_KEY, "1");
  } catch {
    /* nothing to persist to */
  }
}

export function Splash() {
  const [done, setDone] = useState(
    () =>
      alreadySeen() ||
      (typeof window !== "undefined" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches),
  );
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (done) {
      markSeen();
      return;
    }
    const el = ref.current;
    if (!el) return;

    const finish = () => {
      markSeen();
      setDone(true);
    };

    const ctx = gsap.context(() => {
      const timeline = gsap.timeline({ onComplete: finish });

      // The letters rise out of a mask, the rule under them draws across, then
      // the whole thing lifts away. Total: about 1.6s.
      timeline
        .from(".splash-letter", {
          yPercent: 115,
          opacity: 0,
          duration: 0.72,
          stagger: 0.055,
          ease: "power4.out",
        })
        .from(
          ".splash-rule",
          {
            scaleX: 0,
            duration: 0.5,
            ease: "power2.inOut",
            transformOrigin: "left",
          },
          "-=0.28",
        )
        .to(
          ".splash-inner",
          { y: -14, opacity: 0, duration: 0.42, ease: "power2.in" },
          "+=0.22",
        )
        .to(el, { opacity: 0, duration: 0.36, ease: "power1.out" }, "-=0.22");

      const skip = () => {
        timeline.progress(1);
      };
      el.addEventListener("click", skip);
      window.addEventListener("keydown", skip, { once: true });
      window.addEventListener("wheel", skip, { once: true, passive: true });

      return () => {
        el.removeEventListener("click", skip);
        window.removeEventListener("keydown", skip);
        window.removeEventListener("wheel", skip);
      };
    }, el);

    return () => ctx.revert();
  }, [done]);

  if (done) return null;

  return (
    <div className="splash" ref={ref} role="presentation">
      <div className="splash-inner">
        <div className="splash-word">
          {"arclis".split("").map((letter, i) => (
            <span className="splash-mask" key={i}>
              <span className="splash-letter">{letter}</span>
            </span>
          ))}
        </div>
        <div className="splash-rule" />
        <div className="splash-tag">On-chain access to public markets</div>
      </div>
      <button className="splash-skip" onClick={() => setDone(true)}>
        Skip
      </button>
    </div>
  );
}
