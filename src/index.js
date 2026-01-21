'use strict';

var useReflexion = true;
var showStats = false;

// Handle different screen ratios
const mapVal = (value, min1, max1, min2, max2) => min2 + (value - min1) * (max2 - min2) / (max1 - min1);
var fovX = () => mapVal(window.innerWidth / window.innerHeight, 16/9, 9/16, 1.7, Math.PI / 3);

if (navigator.userAgent.match(/(iPad)|(iPhone)|(iPod)|(android)|(webOS)/i)) {
	useReflexion = false;
	// Account for the searchbar
	fovX = () => mapVal(window.innerWidth / window.innerHeight, 16/9, 9/16, 1.5, Math.PI / 3);
}
var fovY = () => 2 * Math.atan(Math.tan(fovX() * 0.5) * window.innerHeight / window.innerWidth);

const Stats = require('stats.js');
var stats = new Stats();
stats.showPanel(0);
if(showStats) {
	document.body.appendChild( stats.dom );
}

let regl, map, drawMap, placement, drawPainting, fps;

regl = require('regl')({
	extensions: [
		//'angle_instanced_arrays',
		'OES_element_index_uint',
		'OES_standard_derivatives'
	],
	optionalExtensions: [
		//'oes_texture_float',
		'EXT_texture_filter_anisotropic'
	],
	attributes: { alpha : false }
});

map = require('./map')();
const mesh = require('./mesh');
drawMap = mesh(regl, map, useReflexion);
placement = require('./placement')(regl, map);
drawPainting = require('./painting')(regl);
fps = require('./fps')(map, fovY);
// --- Help overlay (hide on first real movement) ---
const helpEl = document.createElement("div");
helpEl.id = "help-overlay";
const isMobile = navigator.userAgent.match(/(iPad)|(iPhone)|(iPod)|(android)|(webOS)/i);

helpEl.innerHTML = isMobile
  ? `<b>How to move</b><br>
     • Slide on the screen to look around<br>
     • Use the joystick to move around`
  : `<b>How to move</b><br>
     • QZSD to move around<br>
     • Click, then move mouse to look around`;

const helpStyle = document.createElement("style");
helpStyle.textContent = `
#help-overlay{
  position: fixed;
  top: 14px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 9999;
  padding: 10px 14px;
  border-radius: 10px;
  background: rgba(0,0,0,0.55);
  color: #fff;
  font: 13px/1.35 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  text-align: center;
  pointer-events: none;
  opacity: 1;
  transition: opacity 450ms ease;
  max-width: min(92vw, 520px);
  backdrop-filter: blur(4px);
}
#help-overlay.fadeout{ opacity: 0; }
`;
document.head.appendChild(helpStyle);
document.body.appendChild(helpEl);

let helpHidden = false;
function hideHelp() {
  if (helpHidden) return;
  helpHidden = true;
  helpEl.classList.add("fadeout");
  setTimeout(() => helpEl.remove(), 600);
}

// record initial state to detect movement
let prevPos = fps.pos.slice();
let prevAngle = fps.fmouse[1];

const context = regl({
	cull: {
		enable: true,
		face: 'back'
	},
	uniforms: {
		view: fps.view,
		proj: fps.proj,
		yScale: 1.0
	}
});

const reflexion = regl({
	cull: {
		enable: true,
		face: 'front'
	},
	uniforms: {
		yScale: -1.0
	}
});

regl.frame(({
	time
}) => {
	stats.begin();
	fps.tick({
		time
	});
	// Hide help when player actually moves or changes view direction
	const dx = fps.pos[0] - prevPos[0];
	const dz = fps.pos[2] - prevPos[2];
	const moved = (dx*dx + dz*dz) > 1e-6;        // tiny threshold
	const turned = Math.abs(fps.fmouse[1] - prevAngle) > 1e-4;

	if (!helpHidden && (moved || turned)) hideHelp();

	prevPos = fps.pos.slice();
	prevAngle = fps.fmouse[1];

	// 
	placement.update(fps.pos, fps.fmouse[1], fovX());
	regl.clear({
		color: [0, 0, 0, 1],
		depth: 1
	});
	context(() => {
		if(useReflexion) {
			reflexion(() => {
				drawMap();
				drawPainting(placement.batch());
			});
		}
		drawMap();
		drawPainting(placement.batch());
	});
	stats.end();
});