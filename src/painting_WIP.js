'use strict';

const text = require('./text');

module.exports = (regl) => {
  const drawText = text.draw(regl);

  const painting = regl({
    frag: `
precision lowp float;

uniform sampler2D tex;
varying vec3 uv;

// --- helpers ---
vec4 erf(vec4 x) {
  vec4 s = sign(x), a = abs(x);
  x = 1.0 + (0.278393 + (0.230389 + 0.078108 * (a * a)) * a) * a;
  x *= x;
  return s - s / (x * x);
}

float boxShadow(vec2 lower, vec2 upper, vec2 point, float sigma) {
  vec4 query = vec4(point - lower, upper - point);
  vec4 integral = 0.5 + 0.5 * erf(query * (sqrt(0.5) / sigma));
  return (integral.z - integral.x) * (integral.w - integral.y);
}

// distance from point to inner window boundary (for points outside window)
float distToWindow(vec2 p, float m) {
  vec2 a = vec2(m);
  vec2 b = vec2(1.0 - m);
  vec2 q = clamp(p, a, b);
  return length(p - q);
}

void main () {
  // base masks
  float paintingMask = step(0.001, uv.z);

  // original outer shadow behind painting
  float shadowAlpha = boxShadow(vec2(.5), vec2(.7), abs(uv.xy - vec2(.5)), 0.02);

  // identify surfaces:
  // front image plane is uv.z ~= 1.0
  // contour/sides are uv.z ~= 0.0
  // mat plane is uv.z ~= 1.03 (or any value > 1.015)
  float isMat = step(1.015, uv.z);
  float isFront = step(0.95, uv.z) * (1.0 - isMat);
  float isSide = 1.0 - step(0.95, uv.z); // uv.z < 0.95

  // ---- marie-louise params ----
  float m = 0.14; // mat thickness (visual border size)
  vec3 matCol = vec3(0.94, 0.89, 0.82); // beige board

  // window mask (opening)
  float insideX = step(m, uv.x) * step(uv.x, 1.0 - m);
  float insideY = step(m, uv.y) * step(uv.y, 1.0 - m);
  float insideWindow = insideX * insideY;

  // sample image for front plane only
  vec3 imgCol = texture2D(tex, uv.xy).rgb;

  // --- clean 45° bevel on the mat near the opening ---
  // remove blurry "inner shadow" entirely: use a bevel ramp instead
  float d = distToWindow(uv.xy, m);     // 0 at opening edge, grows into mat
  float bevelW = 0.055;                 // bevel width (UV units)
  float bevelAmt = 1.0 - smoothstep(0.0, bevelW, d);

  // direction from the window edge outward into the mat
  vec2 a = vec2(m);
  vec2 b = vec2(1.0 - m);
  vec2 q = clamp(uv.xy, a, b);
  vec2 dir = uv.xy - q;
  float dirLen = length(dir);
  vec2 dirN = dirLen > 1e-5 ? (dir / dirLen) : vec2(0.0);

  // light from top-left (tweak if needed)
  vec2 lightDir = normalize(vec2(-0.6, 0.8));
  float lit = 0.5 + 0.5 * dot(dirN, lightDir); // 0..1
  // bevel shading: highlight on lit side, shadow on opposite
  float bevelShade = mix(0.82, 1.10, lit); // shadow..highlight

  vec3 matShaded = matCol * mix(1.0, bevelShade, bevelAmt);

  // inner cut line (crisp, no corner artifacts)
  float strokeW = 0.006;
  // For points *inside* window: distance to inner edge (for a crisp line)
  float dx = min(uv.x - m, (1.0 - m) - uv.x);
  float dy = min(uv.y - m, (1.0 - m) - uv.y);
  float dIn = min(dx, dy);
  float innerStroke = (1.0 - smoothstep(0.0, strokeW, dIn)) * insideWindow;

  // compose mat layer:
  // - mat is opaque outside window
  // - transparent inside window to reveal the front image plane behind
  float matAlpha = 1.0 - insideWindow;
  vec3 matLayerCol = matShaded;
  matLayerCol = mix(matLayerCol, vec3(0.0), 0.10 * bevelAmt);     // subtle cut darkening
  matLayerCol = mix(matLayerCol, vec3(0.0), 0.10 * innerStroke);  // thin inner line

  // sides (thickness edges) should be mat color, not the image
  // keep a tiny shading so it reads as depth, but same hue
  float sideShade = 0.78; // darker side
  vec3 sideCol = matCol * sideShade;

  // choose output color/alpha by surface
  vec4 colFront = vec4(imgCol, 1.0);
  vec4 colSide  = vec4(sideCol, 1.0);
  vec4 colMat   = vec4(matLayerCol, matAlpha);

  vec4 col = colFront;
  col = mix(col, colSide, isSide);
  col = mix(col, colMat, isMat);

  // final with outer shadow behind everything
  gl_FragColor = mix(vec4(0.0, 0.0, 0.0, shadowAlpha), col, paintingMask);
}
`,

    vert: `
precision highp float;
uniform mat4 proj, view, model;
uniform float yScale;
uniform float thickness;     // NEW: physical thickness scaling
attribute vec3 pos;
varying vec3 uv;

void main () {
  uv = pos; // keep semantic z for shading/masks

  // Map semantic z -> physical z so we can make thickness very small
  // pos.z = 1.0   (front) stays at 1.0
  // pos.z = 0.0   (back/contour) becomes 1.0 - thickness
  // pos.z = 1.03  (mat protrude) becomes 1.0 + 0.03 * thickness
  float zPhysical = 1.0 + (pos.z - 1.0) * thickness;

  vec4 mpos = model * vec4(pos.x, pos.y, zPhysical, 1.0);
  mpos.y *= yScale;
  gl_Position = proj * view * mpos;
}
`,

    attributes: {
      pos: [
        // Front (semantic z = 1)
        0, 0, 1,
        1, 0, 1,
        0, 1, 1,
        1, 1, 1,

        // Contour/back (semantic z = 0)
        0, 0, 0,
        1, 0, 0,
        0, 1, 0,
        1, 1, 0,

        // Shadow quad (semantic z = 0)
        -0.1, -0.1, 0,
        1.1,  -0.1, 0,
        -0.1,  1.1, 0,
        1.1,   1.1, 0,

        // Marie-louise protruding layer (semantic z slightly > 1)
        0, 0, 1.03,
        1, 0, 1.03,
        0, 1, 1.03,
        1, 1, 1.03
      ]
    },

    elements: [
      // Front
      0, 1, 2, 3, 2, 1,

      // Contour (sides)
      1, 0, 5, 4, 5, 0,
      3, 1, 7, 5, 7, 1,
      0, 2, 4, 6, 4, 2,

      // Shadow
      8,  9,  4, 5, 4, 9,
      9,  11, 5, 7, 5, 11,
      11, 10, 7, 6, 7, 10,
      10, 8,  6, 4, 6, 8,

      // Marie-louise (draw last)
      12, 13, 14, 15, 14, 13
    ],

    uniforms: {
      model: regl.prop('model'),
      tex: regl.prop('tex'),

      // 10× thinner than the original “1.0 thickness” model
      // tweak: 0.10 is “10× thinner”; 0.06 even thinner
      thickness: 0.10
    },

    blend: {
      enable: true,
      func: {
        srcRGB: 'src alpha',
        srcAlpha: 'one minus src alpha',
        dstRGB: 'one minus src alpha',
        dstAlpha: 1
      },
      color: [0, 0, 0, 0]
    }
  });

  return function (batch) {
    painting(batch);
    drawText(batch);
  };
};