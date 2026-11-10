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

  const float PI = 3.14159265;
  const float MAXH = 2.6;
  const float TMAX = 280.0;
  const vec3 F0 = vec3(0.9, 0.9, 0.93);   // polished silver / mercury
  const float ER = 0.034;                 // angular radius of the eclipse disc

  // Per-frame values that only depend on the eclipse position; set at the top of main().
  float gVis;    // eclipse visibility (fades as it sinks below the horizon)
  float gGlow;   // horizon glow, strongest when the eclipse touches the horizon

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

  // ---- Noise ----
  float hash2(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash2(i), b = hash2(i + vec2(1.0, 0.0));
    float c = hash2(i + vec2(0.0, 1.0)), d = hash2(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  float fbm(vec2 p) {
    float s = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) {
      s += a * vnoise(p);
      p = p * 2.03 + vec2(17.1, 9.7);
      a *= 0.5;
    }
    return s;
  }

  // ---- Eclipse void ----
  // uSun is the direction of the eclipse: a black disc with a white-hot rim and corona.

  void setupSun() {
    float sy = uSun.y;
    gVis = smoothstep(-0.12, 0.0, sy);
    gGlow = exp(-abs(sy) * 11.0);
  }

  // The dark itself: near-black, a breath lighter toward the horizon,
  // with a faint pale bloom on the horizon beneath the eclipse.
  vec3 atmosphere(vec3 d) {
    float y = max(d.y, 0.0);
    vec3 c = mix(vec3(0.0012, 0.0013, 0.0018), vec3(0.0045, 0.0048, 0.006), exp(-y * 7.0));
    float toward = max(dot(normalize(d.xz + 1e-5), normalize(uSun.xz + 1e-5)), 0.0);
    c += vec3(0.75, 0.8, 0.9) * pow(toward, 10.0) * exp(-y * 22.0) * 0.045 * gGlow;
    return c;
  }

  vec3 grain(vec3 d, float density, float threshold, float size, float gain) {
    vec2 sc = vec2(atan(d.x, -d.z), asin(clamp(d.y, -1.0, 1.0))) * density;
    vec2 id = floor(sc);
    float h = hash2(id);
    if (h < threshold) return vec3(0.0);
    vec2 off = (vec2(hash2(id + 7.1), hash2(id + 3.7)) - 0.5) * 0.6;
    float r = length(fract(sc) - 0.5 - off);
    float bright = 0.15 + pow(fract(h * 91.7), 10.0) * 6.0;
    return vec3(0.85, 0.88, 1.0) * smoothstep(size, 0.0, r) * bright * gain;
  }

  // Returns the eclipse light; occl is 1 inside the black disc.
  vec3 eclipse(vec3 d, out float occl) {
    occl = 0.0;
    float cosT = dot(d, uSun);
    if (cosT < 0.97) return vec3(0.0);
    float r = sqrt(max(2.0 * (1.0 - cosT), 0.0)) / ER;
    occl = 1.0 - smoothstep(0.985, 1.0, r);

    vec3 eR = normalize(cross(uSun, vec3(0.0, 1.0, 0.0)));
    vec3 eU = cross(eR, uSun);
    vec2 dir = normalize(vec2(dot(d, eR), dot(d, eU)) + 1e-6);

    float outside = smoothstep(0.97, 1.0, r);
    // Razor rim + a slightly softer inner glow.
    float rim = (exp(-pow((r - 1.0) * 40.0, 2.0)) * 14.0 + exp(-pow((r - 1.0) * 9.0, 2.0)) * 1.6) * outside;
    // Corona: streamers that drift very slowly.
    float s1 = fbm(dir * 2.2 + vec2(uTime * 0.015, 0.0));
    float s2 = vnoise(dir * 9.0 - vec2(0.0, uTime * 0.02));
    float streamers = 0.35 + 1.4 * pow(s1, 2.5) + 0.5 * pow(s2, 4.0);
    float rr = max(r, 1.0);
    float corona = (pow(rr, -4.0) * 1.6 + pow(rr, -2.0) * 0.06) * streamers * outside;
    return vec3(1.0, 0.97, 0.93) * rim + vec3(0.82, 0.88, 1.0) * corona;
  }

  // Everything above the sea. studio = 1 for reflections (adds thin light strips for the chrome).
  vec3 sky(vec3 d, float studio) {
    vec3 c = atmosphere(d);
    float y = d.y;
    float above = smoothstep(-0.002, 0.002, y);

    // The horizon: one razor-thin line of light, brighter toward the eclipse.
    float toward = max(dot(normalize(d.xz + 1e-5), normalize(uSun.xz + 1e-5)), 0.0);
    float lineI = 0.22 + 3.0 * pow(toward, 8.0) * gGlow;
    c += vec3(0.88, 0.91, 1.0) * lineI * (exp(-abs(y) * 700.0) + exp(-abs(y) * 90.0) * 0.025);

    // Fine grain stars, hidden behind the disc.
    float occl;
    vec3 e = eclipse(d, occl);
    float starVis = (1.0 - occl) * smoothstep(0.01, 0.08, y);
    if (starVis > 0.0) {
      c += starVis * (grain(d, 320.0, 0.86, 0.2, 0.05) + grain(d, 130.0, 0.975, 0.14, 0.35));
    }
    c = c * (1.0 - occl * above) + e * above * gVis;

    // Thin vertical light strips, seen only in the metal: razor highlights on the swells.
    if (studio > 0.0) {
      float az = atan(d.x, -d.z);
      float strips = pow(0.5 + 0.5 * sin(az * 3.0 + 0.9), 4000.0);
      c += vec3(0.8, 0.85, 1.0) * strips * smoothstep(0.03, 0.12, y) * (1.0 - smoothstep(0.35, 0.6, y)) * 0.18;
    }

    // Below the horizon (reflections pointing down) falls into darkness.
    c = mix(c, vec3(0.002, 0.002, 0.003), 1.0 - smoothstep(-0.25, 0.0, y));
    return c;
  }

  vec3 fresnel(vec3 n, vec3 rd) {
    float ndv = clamp(dot(n, -rd), 0.0, 1.0);
    return F0 + (1.0 - F0) * pow(1.0 - ndv, 5.0);
  }

  // Razor glints of the eclipse rim on the surface.
  vec3 glints(vec3 n, vec3 rd) {
    vec3 h = normalize(uSun - rd);
    float nh = max(dot(n, h), 0.0);
    return vec3(1.0, 0.97, 0.93) * (pow(nh, 1400.0) * 9.0 + pow(nh, 160.0) * 0.12) * gVis;
  }

  void main() {
    setupSun();
    vec2 uv = (gl_FragCoord.xy * 2.0 - uRes) / uRes.y;

    float yaw = uLook.x, pit = uLook.y;
    vec3 f = vec3(sin(yaw) * cos(pit), sin(pit), -cos(yaw) * cos(pit));
    vec3 r = normalize(cross(f, vec3(0.0, 1.0, 0.0)));
    vec3 u = cross(r, f);
    vec3 rd = normalize(f * 1.5 + uv.x * r + uv.y * u);
    vec3 ro = uCam;

    // Horizon colour along this azimuth, used for fog.
    vec3 horizon = atmosphere(normalize(vec3(rd.x, 0.01, rd.z)));

    vec3 col;
    float t;
    float glowMask = 1.0;   // alpha: 0 inside the eclipse disc so bloom can't fill it
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
        second = mix(second, atmosphere(normalize(vec3(refl.x, 0.01, refl.z))), 1.0 - exp(-t2 * 0.02));
        env = mix(env, second, selfW);
      }

      // Troughs are a little darker (light that doesn't escape).
      float occ = 0.65 + 0.35 * smoothstep(-1.6, 1.4, p.y);
      col = env * F * occ + glints(n, rd);

      float fog = 1.0 - exp(-t * 0.0075);
      col = mix(col, horizon, fog * fog);
    } else {
      col = rd.y < 0.0 ? horizon : sky(rd, 0.0);
      if (rd.y > 0.0) {
        float occl;
        eclipse(rd, occl);
        glowMask = 1.0 - occl;
      }
    }

    col = max(col, 0.0);
    outColor = vec4(uLdr > 0.5 ? sqrt(min(col, 8.0) / 8.0) : col, glowMask);
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
    vec4 s4 = texture(uScene, q);
    vec3 s = s4.rgb;
    vec3 col = uLdr > 0.5 ? s * s * 8.0 : s;
    col += texture(uBloom, q).rgb / uEnc * 0.6 * s4.a;   // alpha masks the eclipse disc

    col = aces(col * 1.05);
    col *= 0.6 + 0.4 * pow(16.0 * q.x * q.y * (1.0 - q.x) * (1.0 - q.y), 0.18);
    col = pow(col, vec3(1.0 / 2.2));
    col += (hash(gl_FragCoord.xy + fract(uTime)) - 0.5) * 3.5 / 255.0;   // fine film grain
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

  // ---- Eclipse ----
  // Fixed in the sky, dead ahead in the direction of travel, a little above the horizon.
  const ECLIPSE_ELEVATION = 0.13;   // radians (~7.5°)
  const ECLIPSE_DIR = [0, Math.sin(ECLIPSE_ELEVATION), -Math.cos(ECLIPSE_ELEVATION)];

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
    render(time, cam, look, ECLIPSE_DIR);

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
