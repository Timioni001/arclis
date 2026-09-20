/**
 * The ambient background: a slow, drifting field of noise behind the content.
 *
 * # Why this is hand-written
 *
 * ShaderGradient is the obvious library for this and it is not usable here: it
 * needs react-three-fiber v9, which needs React 19, and it drags in three.js
 * and expo. That is roughly 600KB of dependency to draw a blurred gradient
 * behind a page whose entire bundle is under 300KB. The effect is forty lines
 * of GLSL; the library is not worth its weight for it.
 *
 * # What it draws
 *
 * Two layers of value noise, domain-warped against each other and advanced
 * slowly in time, mapped onto the theme's own colours and multiplied by a
 * radial falloff so it dissolves at the edges rather than ending at one. A
 * very low-opacity grain sits over the top, which is what stops a large soft
 * gradient from banding on an 8-bit display.
 *
 * # What it refuses to do
 *
 * Run when it is not wanted. Reduced motion, reduced transparency, a missing
 * WebGL context, or a hidden tab all stop the loop, and the fallback is a
 * static CSS gradient using the same tokens. It is decoration; it never gets
 * to cost a person their battery or their readability.
 */

import { useEffect, useRef, useState } from "react";
import { useScrollScrub } from "./Reveal";

const VERTEX = `
attribute vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }
`;

const FRAGMENT = `
precision mediump float;

uniform vec2 u_resolution;
uniform float u_time;
uniform vec3 u_accent;
uniform vec3 u_base;
uniform float u_intensity;

// Hash-based value noise. Cheap, and at this scale and blur the artefacts of
// a hash are invisible while a gradient-noise implementation would not be.
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  // Smoothstep the interpolant so the cell boundaries do not show as a grid.
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i + vec2(0.0, 0.0)), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float fbm(vec2 p) {
  float total = 0.0;
  float amplitude = 0.5;
  for (int i = 0; i < 4; i++) {
    total += noise(p) * amplitude;
    p *= 2.0;
    amplitude *= 0.5;
  }
  return total;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  // Correct for aspect so the blobs stay round on a wide viewport.
  vec2 p = uv;
  p.x *= u_resolution.x / u_resolution.y;

  float t = u_time * 0.04;

  // Domain warp: sample the noise at a position that is itself displaced by
  // noise. This is what turns concentric blobs into something that reads as
  // fluid rather than as a lava lamp.
  vec2 warp = vec2(fbm(p * 1.6 + t), fbm(p * 1.6 - t + 4.7));
  float field = fbm(p * 2.2 + warp * 1.4);

  // Radial falloff from slightly above centre, so the densest part sits behind
  // a hero rather than behind the middle of the page.
  vec2 centre = vec2(0.5 * u_resolution.x / u_resolution.y, 0.62);
  float d = distance(p, centre);
  float falloff = smoothstep(0.85, 0.05, d);

  float mask = pow(field, 1.6) * falloff * u_intensity;
  vec3 colour = mix(u_base, u_accent, clamp(mask, 0.0, 1.0));

  gl_FragColor = vec4(colour, clamp(mask * 1.15, 0.0, 1.0));
}
`;

function compile(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

/** Read a CSS custom property as an RGB triple in 0..1. */
function readColour(name: string, fallback: [number, number, number]) {
  if (typeof window === "undefined") return fallback;
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  const hex = raw.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [
      ((n >> 16) & 255) / 255,
      ((n >> 8) & 255) / 255,
      (n & 255) / 255,
    ] as [number, number, number];
  }
  const rgb = raw.match(/(\d+(?:\.\d+)?)/g);
  if (rgb && rgb.length >= 3) {
    return [
      Number(rgb[0]) / 255,
      Number(rgb[1]) / 255,
      Number(rgb[2]) / 255,
    ] as [number, number, number];
  }
  return fallback;
}

export function AmbientShader({ intensity = 0.55 }: { intensity?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  // The whole field shrinks and drifts up as the page scrolls, so the hero has
  // depth without any content moving at its own rate.
  useScrollScrub(wrapRef as React.RefObject<HTMLElement>, {
    scale: 1.25,
    yPercent: -12,
    opacity: 0.35,
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const quiet =
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
      window.matchMedia("(prefers-reduced-transparency: reduce)").matches;
    if (quiet) {
      setFailed(true);
      return;
    }

    const gl = canvas.getContext("webgl", {
      alpha: true,
      antialias: false,
      premultipliedAlpha: false,
      powerPreference: "low-power",
    });
    if (!gl) {
      setFailed(true);
      return;
    }

    const vs = compile(gl, gl.VERTEX_SHADER, VERTEX);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
    const program = gl.createProgram();
    if (!vs || !fs || !program) {
      setFailed(true);
      return;
    }
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      setFailed(true);
      return;
    }
    gl.useProgram(program);

    // One full-screen triangle pair.
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const position = gl.getAttribLocation(program, "position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    const uResolution = gl.getUniformLocation(program, "u_resolution");
    const uTime = gl.getUniformLocation(program, "u_time");
    const uAccent = gl.getUniformLocation(program, "u_accent");
    const uBase = gl.getUniformLocation(program, "u_base");
    const uIntensity = gl.getUniformLocation(program, "u_intensity");

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const resize = () => {
      // Half resolution. The output is a heavily blurred gradient, so the extra
      // pixels buy nothing and cost fill rate on a laptop GPU.
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5) * 0.5;
      const w = Math.floor(canvas.clientWidth * dpr);
      const h = Math.floor(canvas.clientHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
    };

    const syncColours = () => {
      gl.uniform3fv(uAccent, readColour("--lime", [0.78, 0.94, 0.25]));
      gl.uniform3fv(uBase, readColour("--bg", [0.93, 0.94, 0.93]));
    };

    let raf = 0;
    const start = performance.now();
    const frame = () => {
      if (document.hidden) {
        raf = requestAnimationFrame(frame);
        return;
      }
      resize();
      gl.uniform2f(uResolution, canvas.width, canvas.height);
      gl.uniform1f(uTime, (performance.now() - start) / 1000);
      gl.uniform1f(uIntensity, intensity);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      raf = requestAnimationFrame(frame);
    };

    syncColours();
    frame();

    // The palette changes with the theme, so re-read it when the attribute
    // flips rather than rebuilding the whole context.
    const observer = new MutationObserver(syncColours);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      gl.deleteProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteBuffer(buffer);
    };
  }, [intensity]);

  return (
    <div className="ambient" ref={wrapRef} aria-hidden>
      {failed ? (
        <div className="ambient-fallback" />
      ) : (
        <canvas className="ambient-canvas" ref={canvasRef} />
      )}
      <div className="ambient-grain" />
    </div>
  );
}
