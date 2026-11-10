// Infinite Futures — a raymarched ocean of liquid metal.
// No dependencies: WebGL2 with a raymarching scene shader plus a small bloom chain.
//
// Passes each frame:
//   1. scene     → HDR texture (raymarched ocean, self-reflections, sky)
//   2. bright    → quarter-res texture (only the hottest highlights)
//   3. blur x4   → ping-pong gaussian blur of the highlights
//   4. composite → screen (scene + glow, tonemap, vignette, dither)

(() => {
  const canvas = document.getElementById('c');
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'high-performance' });
  if (!gl) {
    document.getElementById('fallback').style.display = 'flex';
    return;
  }

  const VERT = `#version 300 es
  void main() {
    // Full-screen triangle, no vertex buffers needed.
    vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
  }`;

  // ---------------------------------------------------------------- scene
  const SCENE = `#version 300 es
  precision highp float;

  uniform vec2  uRes;
  uniform float uTime;
  uniform vec3  uCam;
  uniform vec2  uLook;   // yaw, pitch
  uniform vec3  uSun;    // sun direction (moves through a set/rise cycle)
  uniform float uLdr;    // 1 when HDR render targets are unavailable
  out vec4 outColor;

  const float MAXH = 2.6;
  const float TMAX = 280.0;
  const vec3 MOON = normalize(vec3(-0.4, 0.27, -0.88));
  const vec3 F0 = vec3(0.9, 0.9, 0.93);   // polished silver / mercury

  // Heavy, slow swells. Small ripples are damped (surface tension) and
  // move only a little faster than the big waves, so the liquid feels dense.
  float H(vec2 p, int n) {
    float t = uTime * 0.35;
    float h = 0.0;
    float a = 1.0;
    float w = 0.32;
    vec2 q = p * 0.1;
    mat2 m = mat2(1.52, 1.14, -1.14, 1.52);
    for (int i = 0; i < 6; i++) {
      if (i >= n) break;
      q += vec2(sin(q.y * 1.3 + t), cos(q.x * 1.1 - t * 0.8)) * w;
      h += a * sin(q.x + t) * cos(q.y * 0.9 - t * 0.7);
      q = m * q;
      a *= 0.36;
      t *= 1.12;
      w *= 0.55;
    }
    return h * 1.35;
  }

  vec3 normalAt(vec2 p, float dist) {
    float e = 0.02 + dist * 0.0015;
    int n = dist < 60.0 ? 5 : (dist < 140.0 ? 4 : 3);
    float hx = H(p + vec2(e, 0.0), n) - H(p - vec2(e, 0.0), n);
    float hz = H(p + vec2(0.0, e), n) - H(p - vec2(0.0, e), n);
    return normalize(vec3(-hx, 2.0 * e, -hz));
  }

  // Sphere-ish tracing against the heightfield, then bisection to refine.
  bool march(vec3 ro, vec3 rd, float tmin, float tmax, int steps, out float tHit) {
    float t;
    if (rd.y < 0.0) t = max(tmin, (ro.y - MAXH) / -rd.y);
    else if (ro.y > MAXH) return false;
    else t = tmin;
    float tPrev = t;
    for (int i = 0; i < 200; i++) {
      if (i >= steps || t > tmax) return false;
      vec3 p = ro + rd * t;
      if (rd.y > 0.0 && p.y > MAXH) return false;
      float d = p.y - H(p.xz, 4);
      if (d < 0.0) {
        float a = tPrev, b = t;
        for (int j = 0; j < 7; j++) {
          float m = 0.5 * (a + b);
          vec3 q = ro + rd * m;
          if (q.y - H(q.xz, 4) < 0.0) b = m; else a = m;
        }
        tHit = 0.5 * (a + b);
        return true;
      }
      tPrev = t;
      t += max(d * 0.55, 0.02 + t * 0.004);
    }
    return false;
  }

  float hash2(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  vec3 stars(vec3 d) {
    if (d.y < 0.0) return vec3(0.0);
    vec2 sc = vec2(atan(d.x, -d.z), asin(clamp(d.y, -1.0, 1.0))) * 90.0;
    vec2 id = floor(sc);
    float h = hash2(id);
    if (h < 0.93) return vec3(0.0);
    vec2 off = (vec2(hash2(id + 7.1), hash2(id + 3.7)) - 0.5) * 0.6;
    float r = length(fract(sc) - 0.5 - off);
    float twinkle = 0.7 + 0.3 * sin(uTime * (1.0 + h * 3.0) + h * 40.0);
    float bright = 0.25 + 2.5 * pow(fract(h * 91.7), 5.0);
    vec3 tint = mix(vec3(0.75, 0.85, 1.0), vec3(1.0, 0.9, 0.75), fract(h * 13.3));
    return tint * smoothstep(0.16, 0.0, r) * bright * twinkle * smoothstep(0.0, 0.12, d.y);
  }

  // Environment reflected by the metal. Blends from a sunset palette to night as the sun sinks.
  // studio = 1 for reflections (adds light panels), 0 when looking at the sky directly.
  vec3 sky(vec3 d, float studio) {
    float y = d.y;
    float sunY = uSun.y;
    float day = smoothstep(-0.14, 0.06, sunY);   // 1 = golden hour, 0 = full night
    float night = 1.0 - day;

    vec3 top = mix(vec3(0.002, 0.003, 0.009), vec3(0.006, 0.008, 0.02), day);
    vec3 mid = mix(vec3(0.007, 0.01, 0.028), vec3(0.05, 0.05, 0.10), day);
    vec3 hor = mix(vec3(0.035, 0.05, 0.095), vec3(0.75, 0.44, 0.32), day);
    vec3 c = mix(hor, mid, smoothstep(0.0, 0.12, y));
    c = mix(c, top, smoothstep(0.12, 0.7, y));

    // Afterglow: a red band on the horizon around the sun's azimuth that lingers after sunset.
    float toward = max(dot(normalize(d.xz + 1e-5), normalize(uSun.xz + 1e-5)), 0.0);
    float afterglow = smoothstep(-0.3, -0.02, sunY) * (1.0 - smoothstep(0.02, 0.14, sunY));
    c += vec3(0.9, 0.32, 0.14) * pow(toward, 3.0) * exp(-max(y, 0.0) * 10.0) * afterglow * 0.7;

    // Light panels for the chrome to catch: bright and warm by day, faint and cool by night.
    float az = atan(d.x, -d.z);
    float panels = pow(0.5 + 0.5 * sin(az * 5.0 + 0.6), 40.0);
    vec3 panelCol = mix(vec3(0.25, 0.32, 0.5) * 0.25, vec3(0.7, 0.8, 1.0) * 1.1, day);
    c += studio * panelCol * panels * smoothstep(0.06, 0.2, y) * (1.0 - smoothstep(0.4, 0.65, y));
    c += studio * panelCol * 0.55 * (1.0 - smoothstep(0.0, 0.05, abs(d.x))) * smoothstep(0.6, 0.85, y);

    // A thin bright horizon line.
    c += mix(vec3(0.3, 0.38, 0.55) * 0.25, vec3(1.0, 0.8, 0.65) * 0.7, day) * exp(-abs(y) * 80.0);

    // Sun glow + disc, fading out as it dips below the horizon.
    float s = max(dot(d, uSun), 0.0);
    float glowVis = smoothstep(-0.16, 0.02, sunY);
    float discVis = smoothstep(-0.02, 0.02, sunY) * smoothstep(-0.01, 0.01, y);
    c += vec3(1.0, 0.55, 0.32) * pow(s, 16.0) * 0.35 * glowVis;
    c += vec3(1.0, 0.85, 0.7) * pow(s, 220.0) * 1.4 * glowVis;
    c += vec3(1.0, 0.95, 0.88) * pow(s, 900.0) * 12.0 * discVis;

    // Night: stars and a moon.
    c += stars(d) * night * night;
    float mo = dot(d, MOON);
    c += vec3(0.75, 0.82, 1.0) * (smoothstep(0.99935, 0.9996, mo) * 2.2 + pow(max(mo, 0.0), 120.0) * 0.12 + pow(max(mo, 0.0), 12.0) * 0.03) * night;

    // Below the horizon (reflections pointing down) falls into darkness.
    c = mix(c, vec3(0.015, 0.016, 0.03) * mix(0.3, 1.0, day), 1.0 - smoothstep(-0.25, 0.0, y));
    return c;
  }

  vec3 fresnel(vec3 n, vec3 rd) {
    float ndv = clamp(dot(n, -rd), 0.0, 1.0);
    return F0 + (1.0 - F0) * pow(1.0 - ndv, 5.0);
  }

  // Sharp sun / moon glints on a surface point.
  vec3 glints(vec3 n, vec3 rd) {
    float day = smoothstep(-0.14, 0.06, uSun.y);
    vec3 hs = normalize(uSun - rd);
    vec3 hm = normalize(MOON - rd);
    return vec3(1.0, 0.85, 0.7) * pow(max(dot(n, hs), 0.0), 600.0) * 6.0 * smoothstep(-0.02, 0.03, uSun.y)
         + vec3(0.75, 0.85, 1.0) * pow(max(dot(n, hm), 0.0), 900.0) * 2.5 * (1.0 - day);
  }

  void main() {
    vec2 uv = (gl_FragCoord.xy * 2.0 - uRes) / uRes.y;

    float yaw = uLook.x, pit = uLook.y;
    vec3 f = vec3(sin(yaw) * cos(pit), sin(pit), -cos(yaw) * cos(pit));
    vec3 r = normalize(cross(f, vec3(0.0, 1.0, 0.0)));
    vec3 u = cross(r, f);
    vec3 rd = normalize(f * 1.5 + uv.x * r + uv.y * u);
    vec3 ro = uCam;

    // Horizon colour along this azimuth, used for fog.
    vec3 horizon = sky(normalize(vec3(rd.x, 0.015, rd.z)), 0.0);

    vec3 col;
    float t;
    if (march(ro, rd, 0.0, TMAX, 180, t)) {
      vec3 p = ro + rd * t;
      vec3 n = normalAt(p.xz, t);
      vec3 refl = reflect(rd, n);
      vec3 F = fresnel(n, rd);

      // Reflection: first see whether the reflected ray hits another swell
      // (the metal mirroring itself), otherwise it sees the sky.
      vec3 env = sky(refl, 1.0);
      float selfW = 1.0 - smoothstep(70.0, 130.0, t);
      float t2;
      if (selfW > 0.0 && march(p + n * 0.06, refl, 0.12, 70.0, 56, t2)) {
        vec3 p2 = p + n * 0.06 + refl * t2;
        vec3 n2 = normalAt(p2.xz, t + t2 + 30.0);
        vec3 refl2 = reflect(refl, n2);
        vec3 second = sky(refl2, 1.0) * fresnel(n2, refl) + glints(n2, refl);
        // Distant self-reflections fade into the horizon haze.
        second = mix(second, sky(normalize(vec3(refl.x, 0.015, refl.z)), 0.0), 1.0 - exp(-t2 * 0.02));
        env = mix(env, second, selfW);
      }

      // Troughs are a little darker (light that doesn't escape).
      float occ = 0.65 + 0.35 * smoothstep(-1.6, 1.4, p.y);
      col = env * F * occ + glints(n, rd);

      float fog = 1.0 - exp(-t * 0.0075);
      col = mix(col, horizon, fog * fog);
    } else {
      col = rd.y < 0.0 ? horizon : sky(rd, 0.0);
    }

    col = max(col, 0.0);
    outColor = vec4(uLdr > 0.5 ? sqrt(min(col, 8.0) / 8.0) : col, 1.0);
  }`;

  // ---------------------------------------------------------------- bloom
  const BRIGHT = `#version 300 es
  precision highp float;
  uniform sampler2D uTex;
  uniform vec2 uOutRes;
  uniform vec2 uTexel;
  uniform float uLdr;
  uniform float uEnc;
  out vec4 outColor;
  vec3 dec(vec3 s) { return uLdr > 0.5 ? s * s * 8.0 : s; }
  void main() {
    vec2 uv = gl_FragCoord.xy / uOutRes;
    vec3 c = dec(texture(uTex, uv + uTexel * vec2(-1.0, -1.0)).rgb)
           + dec(texture(uTex, uv + uTexel * vec2( 1.0, -1.0)).rgb)
           + dec(texture(uTex, uv + uTexel * vec2(-1.0,  1.0)).rgb)
           + dec(texture(uTex, uv + uTexel * vec2( 1.0,  1.0)).rgb);
    c *= 0.25;
    float b = max(c.r, max(c.g, c.b));
    c *= smoothstep(2.0, 6.0, b);
    outColor = vec4(c * uEnc, 1.0);
  }`;

  const BLUR = `#version 300 es
  precision highp float;
  uniform sampler2D uTex;
  uniform vec2 uOutRes;
  uniform vec2 uDir;
  out vec4 outColor;
  void main() {
    vec2 uv = gl_FragCoord.xy / uOutRes;
    vec3 c = texture(uTex, uv).rgb * 0.2270;
    c += (texture(uTex, uv + uDir * 1.3846).rgb + texture(uTex, uv - uDir * 1.3846).rgb) * 0.3162;
    c += (texture(uTex, uv + uDir * 3.2308).rgb + texture(uTex, uv - uDir * 3.2308).rgb) * 0.0703;
    outColor = vec4(c, 1.0);
  }`;

  const COMPOSITE = `#version 300 es
  precision highp float;
  uniform sampler2D uScene;
  uniform sampler2D uBloom;
  uniform vec2 uRes;
  uniform float uTime;
  uniform float uLdr;
  uniform float uEnc;
  out vec4 outColor;

  vec3 aces(vec3 x) {
    return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
  }
  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
  }
  void main() {
    vec2 q = gl_FragCoord.xy / uRes;
    vec3 s = texture(uScene, q).rgb;
    vec3 col = uLdr > 0.5 ? s * s * 8.0 : s;
    col += texture(uBloom, q).rgb / uEnc * 0.6;

    col = aces(col * 1.05);
    col *= 0.6 + 0.4 * pow(16.0 * q.x * q.y * (1.0 - q.x) * (1.0 - q.y), 0.18);
    col = pow(col, vec3(1.0 / 2.2));
    col += (hash(gl_FragCoord.xy + fract(uTime)) - 0.5) / 255.0;
    outColor = vec4(col, 1.0);
  }`;

  // ---------------------------------------------------------------- GL setup
  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(s));
    }
    return s;
  }

  const vert = compile(gl.VERTEX_SHADER, VERT);
  function program(fragSrc, uniforms) {
    const p = gl.createProgram();
    gl.attachShader(p, vert);
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fragSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(p));
    }
    const u = {};
    for (const name of uniforms) u[name] = gl.getUniformLocation(p, name);
    return { p, u };
  }

  const scene = program(SCENE, ['uRes', 'uTime', 'uCam', 'uLook', 'uSun', 'uLdr']);
  const bright = program(BRIGHT, ['uTex', 'uOutRes', 'uTexel', 'uLdr', 'uEnc']);
  const blur = program(BLUR, ['uTex', 'uOutRes', 'uDir']);
  const composite = program(COMPOSITE, ['uScene', 'uBloom', 'uRes', 'uTime', 'uLdr', 'uEnc']);
  gl.bindVertexArray(gl.createVertexArray());

  // Prefer half-float render targets; fall back to 8-bit with a sqrt encoding.
  let hdr = !!gl.getExtension('EXT_color_buffer_float');

  function createTarget(w, h) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, hdr ? gl.RGBA16F : gl.RGBA8, w, h, 0, gl.RGBA,
      hdr ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fbo, w, h, ok };
  }

  function deleteTarget(t) {
    if (!t) return;
    gl.deleteTexture(t.tex);
    gl.deleteFramebuffer(t.fbo);
  }

  let sceneRT, bloomA, bloomB;

  // ---- Resolution (adaptive, to keep the frame rate smooth) ----
  const maxScale = Math.min(window.devicePixelRatio || 1, 1.5);
  let scale = Math.min(1, maxScale);

  function resize() {
    const w = Math.max(1, Math.round(window.innerWidth * scale));
    const h = Math.max(1, Math.round(window.innerHeight * scale));
    if (sceneRT && canvas.width === w && canvas.height === h) return;
    canvas.width = w;
    canvas.height = h;
    [sceneRT, bloomA, bloomB].forEach(deleteTarget);
    const bw = Math.max(1, Math.floor(w / 4));
    const bh = Math.max(1, Math.floor(h / 4));
    sceneRT = createTarget(w, h);
    if (!sceneRT.ok && hdr) {
      hdr = false;
      deleteTarget(sceneRT);
      sceneRT = createTarget(w, h);
    }
    bloomA = createTarget(bw, bh);
    bloomB = createTarget(bw, bh);
  }
  window.addEventListener('resize', resize);
  resize();

  // ---- Look controls ----
  const MAX_YAW = 1.7;      // ~97° either side
  const MAX_PITCH = 0.75;
  const BASE_PITCH = -0.1;
  let targetYaw = 0, targetPitch = BASE_PITCH;
  let yaw = 0, pitch = BASE_PITCH;

  function lookAt(clientX, clientY) {
    const nx = (clientX / window.innerWidth) * 2 - 1;
    const ny = (clientY / window.innerHeight) * 2 - 1;
    targetYaw = nx * MAX_YAW;
    targetPitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, BASE_PITCH - ny * MAX_PITCH));
  }
  window.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse' || e.buttons) lookAt(e.clientX, e.clientY);
  });
  window.addEventListener('pointerdown', (e) => lookAt(e.clientX, e.clientY));
  document.addEventListener('mouseleave', () => { targetYaw = 0; targetPitch = BASE_PITCH; });

  // ---- Sun cycle ----
  // The sun bobs between just above the horizon and well below it, so it never climbs high.
  const CYCLE = 60;           // seconds for a full set → night → rise → set loop
  const SUN_HIGH = 0.16;      // max elevation (radians, ~9°)
  const SUN_LOW = -0.32;      // lowest point during the night
  // Optional ?t=<seconds> skips ahead in the cycle (handy for previewing night).
  const cycleOffset = parseFloat(new URLSearchParams(location.search).get('t')) || 0;

  function sunDirection(time) {
    const phase = ((time + cycleOffset) / CYCLE) * Math.PI * 2;
    const elev = SUN_LOW + (SUN_HIGH - SUN_LOW) * (0.5 + 0.5 * Math.cos(phase));
    const az = Math.sin(phase * 0.5) * 0.12;   // a slight drift in where it sets and rises
    return [Math.sin(az) * Math.cos(elev), Math.sin(elev), -Math.cos(az) * Math.cos(elev)];
  }

  // ---- Render passes ----
  function bindTarget(t) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fbo : null);
    gl.viewport(0, 0, t ? t.w : canvas.width, t ? t.h : canvas.height);
  }
  function bindTex(unit, tex) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }
  const draw = () => gl.drawArrays(gl.TRIANGLES, 0, 3);

  function render(time, cam, look, sun) {
    const ldr = hdr ? 0 : 1;
    const enc = hdr ? 1 : 0.25;   // keeps 8-bit bloom targets from clipping

    // 1. Scene
    bindTarget(sceneRT);
    gl.useProgram(scene.p);
    gl.uniform2f(scene.u.uRes, sceneRT.w, sceneRT.h);
    gl.uniform1f(scene.u.uTime, time);
    gl.uniform3f(scene.u.uCam, cam[0], cam[1], cam[2]);
    gl.uniform2f(scene.u.uLook, look[0], look[1]);
    gl.uniform3f(scene.u.uSun, sun[0], sun[1], sun[2]);
    gl.uniform1f(scene.u.uLdr, ldr);
    draw();

    // 2. Bright pass + downsample
    bindTarget(bloomA);
    gl.useProgram(bright.p);
    bindTex(0, sceneRT.tex);
    gl.uniform1i(bright.u.uTex, 0);
    gl.uniform2f(bright.u.uOutRes, bloomA.w, bloomA.h);
    gl.uniform2f(bright.u.uTexel, 1 / sceneRT.w, 1 / sceneRT.h);
    gl.uniform1f(bright.u.uLdr, ldr);
    gl.uniform1f(bright.u.uEnc, enc);
    draw();

    // 3. Blur: two rounds of horizontal + vertical, the second one wider
    gl.useProgram(blur.p);
    gl.uniform1i(blur.u.uTex, 0);
    gl.uniform2f(blur.u.uOutRes, bloomA.w, bloomA.h);
    for (const spread of [1, 2.2]) {
      bindTarget(bloomB);
      bindTex(0, bloomA.tex);
      gl.uniform2f(blur.u.uDir, spread / bloomA.w, 0);
      draw();
      bindTarget(bloomA);
      bindTex(0, bloomB.tex);
      gl.uniform2f(blur.u.uDir, 0, spread / bloomA.h);
      draw();
    }

    // 4. Composite to screen
    bindTarget(null);
    gl.useProgram(composite.p);
    bindTex(0, sceneRT.tex);
    bindTex(1, bloomA.tex);
    gl.uniform1i(composite.u.uScene, 0);
    gl.uniform1i(composite.u.uBloom, 1);
    gl.uniform2f(composite.u.uRes, canvas.width, canvas.height);
    gl.uniform1f(composite.u.uTime, time);
    gl.uniform1f(composite.u.uLdr, ldr);
    gl.uniform1f(composite.u.uEnc, enc);
    draw();
  }

  // ---- Loop ----
  const SPEED = 4.0;   // units per second, always forward along -Z
  const start = performance.now();
  let last = start;
  let frames = 0, accum = 0;

  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const time = (now - start) / 1000;

    const k = 1 - Math.exp(-dt * 2.5);
    yaw += (targetYaw - yaw) * k;
    pitch += (targetPitch - pitch) * k;

    // Gentle drift so the ride feels like floating.
    const cam = [Math.sin(time * 0.07) * 6.0, 4.2 + Math.sin(time * 0.35) * 0.35, -time * SPEED];
    const look = [yaw, pitch + Math.sin(time * 0.5) * 0.015];
    render(time, cam, look, sunDirection(time));

    // Adapt resolution every ~40 frames.
    accum += dt; frames++;
    if (frames >= 40) {
      const avg = accum / frames;
      const prev = scale;
      if (avg > 0.024) scale = Math.max(0.35, scale * 0.85);
      else if (avg < 0.0145) scale = Math.min(maxScale, scale * 1.08);
      if (Math.abs(prev - scale) > 0.01) resize();
      frames = 0; accum = 0;
    }

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
