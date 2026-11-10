// Infinite Futures (retro) — the liquid-metal ocean as a late-90s console game:
// a 240-line framebuffer, true low-poly waves, a 16-level palette with ordered dithering, heavy fog.
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
  const vec3 MOON = normalize(vec3(-0.4, 0.27, -0.88));
  const vec3 F0 = vec3(0.9, 0.9, 0.93);   // polished silver / mercury

  // ---- Atmosphere constants (Preetham-style analytic scattering) ----
  const vec3 TOTAL_RAYLEIGH = vec3(5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5);
  const vec3 MIE_CONST = vec3(1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14);
  const float TURBIDITY = 4.5;
  const float RAYLEIGH = 2.2;
  const float MIE_COEF = 0.003;
  const float MIE_G = 0.82;

  // Per-frame values that only depend on the sun; filled in at the top of main().
  vec3  gBetaR, gBetaM;
  float gSunE;      // scattering intensity (fades through twilight)
  vec3  gSunCol;    // sunlight colour at the surface (reddens near the horizon)
  vec3  gCloudSun;  // sunlight reaching high clouds (lingers after sunset)
  float gDay;       // 1 = sun up, 0 = full night
  float gExposure;  // eye/camera adaptation for the sky

  // Heavy, slow swells. Small ripples are damped (surface tension) and
  // move only a little faster than the big waves, so the liquid feels dense.
  float Hs(vec2 p, int n) {
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

  const float GRID = 4.0;   // triangle size in world units

  // Corners of the grid triangle containing p.
  void tri(vec2 p, out vec2 a, out vec2 b, out vec2 c, out vec3 w) {
    vec2 cell = floor(p / GRID);
    vec2 f = fract(p / GRID);
    a = cell * GRID;
    c = (cell + 1.0) * GRID;
    if (f.x > f.y) { b = (cell + vec2(1.0, 0.0)) * GRID; w = vec3(1.0 - f.x, f.x - f.y, f.y); }
    else           { b = (cell + vec2(0.0, 1.0)) * GRID; w = vec3(1.0 - f.y, f.y - f.x, f.x); }
  }

  float H(vec2 p, int n) {
    vec2 a, b, c; vec3 w;
    tri(p, a, b, c, w);
    int m = min(n, 4);
    return w.x * Hs(a, m) + w.y * Hs(b, m) + w.z * Hs(c, m);
  }

  vec3 normalAtSmooth(vec2 p, float dist) {
    float e = 0.02 + dist * 0.0015;
    int n = dist < 60.0 ? 5 : (dist < 140.0 ? 4 : 3);
    float hx = H(p + vec2(e, 0.0), n) - H(p - vec2(e, 0.0), n);
    float hz = H(p + vec2(0.0, e), n) - H(p - vec2(0.0, e), n);
    return normalize(vec3(-hx, 2.0 * e, -hz));
  }

  // Flat normal of the facet under p.
  vec3 normalAt(vec2 p, float dist) {
    vec2 a, b, c; vec3 w;
    tri(p, a, b, c, w);
    vec3 A = vec3(a.x, Hs(a, 4), a.y);
    vec3 B = vec3(b.x, Hs(b, 4), b.y);
    vec3 C = vec3(c.x, Hs(c, 4), c.y);
    vec3 n = normalize(cross(B - A, C - A));
    return n.y < 0.0 ? -n : n;
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

  // ---- Atmosphere ----
  // Relative air mass along a direction with the given elevation (Kasten–Young).
  float airMass(float y) {
    float zen = acos(clamp(y, 0.0, 1.0));
    return 1.0 / (cos(zen) + 0.15 * pow(93.885 - zen * 180.0 / PI, -1.253));
  }

  vec3 transmittance(float y) {
    float m = airMass(y);
    return exp(-(gBetaR * 8.4e3 + gBetaM * 1.25e3) * m);
  }

  void setupSun() {
    gBetaR = TOTAL_RAYLEIGH * RAYLEIGH;
    gBetaM = 0.434 * (0.2 * TURBIDITY * 1e-17) * MIE_CONST * MIE_COEF;

    float sy = uSun.y;
    float zen = acos(clamp(max(sy, 0.0), -1.0, 1.0));
    gSunE = 1000.0 * max(0.0, 1.0 - exp(-((1.6110731556870734 - zen) / 1.5)));
    gSunE *= exp(min(sy, 0.0) * 26.0);                  // twilight: scattered light fades slowly
    gDay = smoothstep(-0.14, 0.04, sy);

    // Adapt exposure so a higher sun doesn't blow out the sky (scattered light ~ sunE^2),
    // then let brightness fall away gradually through twilight.
    float brightness = pow(smoothstep(-0.22, 0.06, sy), 2.0);
    gExposure = pow(64.5 / max(gSunE, 1e-4), 2.0) * brightness;

    gSunCol = transmittance(max(sy, 0.0)) * smoothstep(-0.015, 0.01, sy);
    float cloudY = sy + 0.05;                            // high clouds still see the sun after sunset
    gCloudSun = transmittance(max(cloudY, 0.0)) * smoothstep(-0.02, 0.02, cloudY) * 2.2;
  }

  vec3 atmosphere(vec3 d) {
    float m = airMass(d.y);
    vec3 fex = exp(-(gBetaR * 8.4e3 + gBetaM * 1.25e3) * m);
    float cosT = dot(d, uSun);
    float rPhase = (3.0 / (16.0 * PI)) * (1.0 + pow(cosT * 0.5 + 0.5, 2.0));
    float g2 = MIE_G * MIE_G;
    float mPhase = (1.0 / (4.0 * PI)) * ((1.0 - g2) / pow(1.0 - 2.0 * MIE_G * cosT + g2, 1.5));
    vec3 ratio = (gBetaR * rPhase + gBetaM * mPhase) / (gBetaR + gBetaM);
    vec3 lin = pow(gSunE * ratio * (1.0 - fex), vec3(1.5));
    lin *= mix(vec3(1.0), pow(gSunE * ratio * fex, vec3(0.5)), clamp(pow(1.0 - max(uSun.y, 0.0), 5.0), 0.0, 1.0));
    // Compress the model's huge range gently so the zenith stays deep and the sun side glows.
    vec3 c = pow(lin * 0.02 * gExposure, vec3(0.8));

    // Night: a deep blue-black dome, slightly lifted toward the horizon.
    float y = max(d.y, 0.0);
    c += mix(vec3(0.0012, 0.0018, 0.0042), vec3(0.006, 0.0085, 0.016), exp(-y * 5.0));
    return c;
  }

  float cloudCover(vec3 d) {
    if (d.y < 0.012) return 0.0;
    // Project onto a high cloud deck; the camera's travel adds slow parallax.
    vec2 p = (d.xz * (300.0 / (d.y + 0.03)) + uCam.xz) / 300.0;
    p.x += uTime * 0.012;
    vec2 q = vec2(p.x * 0.55 + p.y * 0.2, p.y * 1.7);   // stretched into streaks
    float w = fbm(q * 0.6);
    float n = fbm(q + vec2(w * 1.9, w * 0.7));
    return smoothstep(0.5, 0.82, n) * smoothstep(0.012, 0.14, d.y);
  }

  vec3 stars(vec3 d, float density, float threshold, float size) {
    vec2 sc = vec2(atan(d.x, -d.z), asin(clamp(d.y, -1.0, 1.0))) * density;
    vec2 id = floor(sc);
    float h = hash2(id);
    if (h < threshold) return vec3(0.0);
    vec2 off = (vec2(hash2(id + 7.1), hash2(id + 3.7)) - 0.5) * 0.6;
    float r = length(fract(sc) - 0.5 - off);
    float twinkle = 0.75 + 0.25 * sin(uTime * (1.0 + h * 3.0) + h * 40.0);
    float bright = 0.08 + 2.2 * pow(fract(h * 91.7), 8.0);
    vec3 tint = mix(vec3(0.72, 0.82, 1.0), vec3(1.0, 0.88, 0.72), fract(h * 13.3));
    return tint * smoothstep(size, 0.0, r) * bright * twinkle;
  }

  // Everything above the sea. studio = 1 for reflections (adds light panels for the chrome).
  vec3 sky(vec3 d, float studio) {
    vec3 c = atmosphere(d);
    float y = d.y;
    float night = 1.0 - gDay;
    float above = smoothstep(-0.004, 0.004, y);

    float cov = cloudCover(d);

    // Stars only show once the sky itself is dark.
    float lum = dot(c, vec3(0.3, 0.5, 0.2));
    float starVis = clamp(1.0 - lum * 40.0, 0.0, 1.0) * (1.0 - cov) * smoothstep(0.02, 0.15, y);
    if (starVis > 0.0) {
      vec3 mwAxis = normalize(vec3(0.35, 0.55, -0.76));
      float b = dot(d, mwAxis);
      float band = exp(-b * b * 14.0);
      float mw = band * fbm(vec2(dot(d, vec3(0.8, 0.0, 0.6)), d.y) * 9.0);
      c += starVis * (stars(d, 110.0, 0.955, 0.12) + stars(d, 260.0, 0.94 - band * 0.08, 0.14) * 0.35
                      + vec3(0.010, 0.011, 0.016) * mw);
    }

    // Moon: a small shaded disc with a faint halo.
    float mo = dot(d, MOON);
    if (night > 0.0 && mo > 0.9) {
      vec3 mR = normalize(cross(MOON, vec3(0.0, 1.0, 0.0)));
      vec3 mU = cross(mR, MOON);
      vec2 mp = vec2(dot(d, mR), dot(d, mU)) / 0.013;
      float r = length(mp);
      float disc = 1.0 - smoothstep(0.92, 1.0, r);
      float limb = pow(max(1.0 - r * r, 0.0), 0.25);
      float maria = 0.72 + 0.28 * fbm(mp * 1.7 + 3.0);
      vec3 moonCol = vec3(1.0, 0.97, 0.92) * 2.6 * disc * limb * maria;
      vec3 halo = vec3(0.6, 0.7, 0.9) * (pow(mo, 2500.0) * 0.08 + pow(mo, 120.0) * 0.012);
      c += (moonCol * (1.0 - cov * 0.85) + halo) * night * above;
    }

    // Sun: a small limb-darkened disc, coloured by the air it shines through.
    float cosT = dot(d, uSun);
    if (cosT > 0.9999) {
      float r = sqrt(max(2.0 * (1.0 - cosT), 0.0)) / 0.009;
      float disc = 1.0 - smoothstep(0.9, 1.0, r);
      float limb = 0.55 + 0.45 * sqrt(max(1.0 - r * r, 0.0));
      c += gSunCol * 70.0 * disc * limb * above * (1.0 - cov * 0.7);
    }

    // High clouds: lit warm from the sun's side, glowing at sunset, silhouettes at night.
    if (cov > 0.0) {
      float s = max(cosT, 0.0);
      float fwd = pow(s, 10.0) * 2.2 + pow(s, 2.0) * 0.45 + 0.18;
      vec3 lit = gCloudSun * fwd * 0.55;
      vec3 moonLit = vec3(0.012, 0.014, 0.02) * (pow(max(mo, 0.0), 8.0) * 3.0 + 0.25) * night;
      vec3 cloud = c * 0.55 + lit * (1.0 - 0.35 * cov) + moonLit;
      c = mix(c, cloud, cov * 0.88);
    }

    // Soft light panels for the chrome to catch (reflections only).
    if (studio > 0.0) {
      float az = atan(d.x, -d.z);
      float panels = pow(0.5 + 0.5 * sin(az * 5.0 + 0.6), 40.0);
      vec3 panelCol = mix(vec3(0.25, 0.32, 0.5) * 0.08, vec3(0.7, 0.8, 1.0) * 0.85, gDay);
      c += panelCol * panels * smoothstep(0.06, 0.2, y) * (1.0 - smoothstep(0.4, 0.65, y));
      c += panelCol * 0.5 * (1.0 - smoothstep(0.0, 0.05, abs(d.x))) * smoothstep(0.6, 0.85, y);
    }

    // Below the horizon (reflections pointing down) falls into darkness.
    c = mix(c, vec3(0.015, 0.016, 0.03) * mix(0.3, 1.0, gDay), 1.0 - smoothstep(-0.25, 0.0, y));
    return c;
  }

  vec3 fresnel(vec3 n, vec3 rd) {
    float ndv = clamp(dot(n, -rd), 0.0, 1.0);
    return F0 + (1.0 - F0) * pow(1.0 - ndv, 5.0);
  }

  // Sharp sun / moon glints on a surface point.
  vec3 glints(vec3 n, vec3 rd) {
    vec3 hs = normalize(uSun - rd);
    vec3 hm = normalize(MOON - rd);
    return gSunCol * pow(max(dot(n, hs), 0.0), 600.0) * 14.0
         + vec3(0.75, 0.85, 1.0) * pow(max(dot(n, hm), 0.0), 900.0) * 2.5 * (1.0 - gDay);
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

      float fog = 1.0 - exp(-t * 0.018);
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
    vec2 px = floor(gl_FragCoord.xy);
    int bi = int(mod(px.x, 4.0)) + int(mod(px.y, 4.0)) * 4;
    float bayer[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
    col = floor(col * 15.0 + (bayer[bi] + 0.5) / 16.0) / 15.0;
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
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
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
  const LINES = 240;   // vertical resolution of the framebuffer
  let scale = 1;

  function resize() {
    scale = LINES / Math.max(LINES, window.innerHeight);
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

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
