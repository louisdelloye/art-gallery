'use strict';
const mat4 = require('gl-mat4');
const vec3 = require('gl-vec3');
const lock = require('pointer-lock');
//const footstep = require('./footstep')();

const mouseSensibility = 0.002;
const touchSensibility = 0.008;
const rotationFilter = 0.95;
const limitAngle = Math.PI / 4;
const slowAngle = Math.PI / 6;
const durationToClick = 300;
const distToClick = 20;
const walkSpeed = 7;
const runSpeed = 12;
const walkStepLen = 3.6;
const runStepLen = 5;
const height = 2;
const stepHeight = 0.03;
const distToWalls = 0.5;
const viewingDist = 3;
const paintingSnapDist = 1.3;
const yLimitTouch = 5;
const touchDistLimit = 40;
const rayStep = 4;
const tpDuration = 1;

const sdLine = (p, a, b, tmp1, tmp2) => {
	const pa = vec3.sub(tmp1, p, a);
	const ba = vec3.sub(tmp2, b, a);
	const h = Math.max(Math.min(vec3.dot(pa, ba) / vec3.dot(ba, ba), 1), 0);
	return vec3.dist(pa, vec3.scale(ba, ba, h));
};

const planeProject = (org, dir, plane) => {
	const dist = -(vec3.dot(org, plane) - plane[3]) / vec3.dot(dir, plane);
	let intersection = vec3.scale([], dir, dist);
	vec3.add(intersection, intersection, org);
	return {dist, intersection};
};

const wallProject = (org, dir, a, b) => {
	// Calculate the vertical place passing through A and B
	const vx = a[0]-b[0], vz = a[1]-b[1];
	const nx = -vz, nz = vx;
	const wAB = a[0] * nx + a[1] * nz;
	// Project to the plane
	let {dist, intersection: i} = planeProject(org, dir, [nx, 0, nz, wAB]);
	// Verify it's between A and B
	const wA = a[0] * vx + a[1] * vz;
	const wB = b[0] * vx + b[1] * vz;
	const wI = i[0] * vx + i[2] * vz;
	if((wI > wA) + (wI > wB) !== 1)
		dist = Infinity;
	//console.log(dist, i);
	return {a, b, dist, intersection: i};
};

const lerp = (x, a, b) => (1 - x) * a + x * b;

const easeInOutQuad = x =>
	x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;

module.exports = function ({getGridSegments, getGridParts}, fovY) {
	var mouse = [0, Math.PI * 3 / 4];
	var fmouse = [0, Math.PI * 3 / 4];
	var dir = [0, 0, 0];
	var pos = [2, height, 2];
	var forward = [0.707, 0, 0.707], up = [0, 1, 0];
	var force = [0, 0, 0];
	var walkTime = 0.5;
	var view = mat4.identity([]);
	var proj = mat4.identity([]);
	var run = false;
	var startPos = [0,0,0];
	var endPos = [0,0,0];
	var tpProgress = 1;

	const orientCamera = (dx, dy, sensibility)=> {
		dx = Math.max(Math.min(dx, 100), -100);
		dy = Math.max(Math.min(dy, 100), -100);
		let smooth = 1;
		if (Math.abs(mouse[0]) > slowAngle && Math.sign(mouse[0]) == Math.sign(dy))
			smooth = (limitAngle - Math.abs(mouse[0])) / (limitAngle - slowAngle);
		mouse[0] += smooth * dy * sensibility;
		mouse[1] += dx * sensibility;
	};

	// Mouse input
	let pointer = lock(document.body);
	pointer.on('attain', (movements) => {
		movements.on('data', (move) => {
			orientCamera(move.dx, move.dy, mouseSensibility);
		});
	});

	// Touch input (VISIBLE joystick)
	// Left thumb: joystick movement
	// Right thumb: swipe to look
	// Teleport on tap is disabled to avoid conflicts.

	const isTouchDevice = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;

	let moveTouchId = null;
	let lookTouchId = null;
	let lookLast = null;

	// --- Create joystick UI ---
	let joy = null;
	let joyKnob = null;
	let joyActive = false;
	let joyCenter = { x: 0, y: 0 };
	let joyVec = { x: 0, y: 0 };
	const joyRadius = 55;        // px
	const joyDeadZone = 6;       // px
	const joyMax = joyRadius;    // px

	function createJoystick() {
		if (joy) return;

		joy = document.createElement('div');
		joy.id = 'joystick';
		joyKnob = document.createElement('div');
		joyKnob.id = 'joystick-knob';
		joy.appendChild(joyKnob);

		const style = document.createElement('style');
		style.textContent = `
			#joystick{
				position: fixed;
				left: 18px;
				bottom: 18px;
				width: ${joyRadius * 2}px;
				height: ${joyRadius * 2}px;
				border-radius: 999px;
				background: rgba(255,255,255,0.10);
				border: 1px solid rgba(255,255,255,0.20);
				backdrop-filter: blur(3px);
				z-index: 9999;
				touch-action: none;
				-webkit-user-select: none;
				user-select: none;
			}
			#joystick-knob{
				position: absolute;
				left: 50%;
				top: 50%;
				width: ${Math.round(joyRadius * 0.90)}px;
				height: ${Math.round(joyRadius * 0.90)}px;
				border-radius: 999px;
				transform: translate(-50%, -50%);
				background: rgba(255,255,255,0.18);
				border: 1px solid rgba(255,255,255,0.28);
				box-shadow: 0 6px 18px rgba(0,0,0,0.22);
			}
		`;
		document.head.appendChild(style);
		document.body.appendChild(joy);
	}

	function setJoyKnob(dx, dy) {
		// dx,dy in px relative to center, clamped
		const cx = dx;
		const cy = dy;
		joyKnob.style.transform = `translate(calc(-50% + ${cx}px), calc(-50% + ${cy}px))`;
	}

	function resetJoystick() {
		joyActive = false;
		joyVec.x = 0;
		joyVec.y = 0;
		setJoyKnob(0, 0);
		// stop movement
		dir = [0, 0, 0];
	}

	function updateDirFromJoy() {
		// Map joystick vector to existing dir convention:
		// dir = [right-left, 0, down-up]
		// Our joyVec: x right positive, y down positive
		dir = [joyVec.x, 0, joyVec.y];
	}

	function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

	function beginJoy(touch) {
		joyActive = true;
		moveTouchId = touch.identifier;

		const rect = joy.getBoundingClientRect();
		joyCenter.x = rect.left + rect.width / 2;
		joyCenter.y = rect.top + rect.height / 2;

		// start centered
		joyVec.x = 0;
		joyVec.y = 0;
		setJoyKnob(0, 0);
		updateDirFromJoy();
	}

	function moveJoy(touch) {
		if (!joyActive) return;

		let dx = touch.clientX - joyCenter.x;
		let dy = touch.clientY - joyCenter.y;

		const dist = Math.hypot(dx, dy);

		// deadzone
		if (dist < joyDeadZone) {
			joyVec.x = 0;
			joyVec.y = 0;
			setJoyKnob(0, 0);
			updateDirFromJoy();
			return;
		}

		// clamp to radius
		if (dist > joyMax) {
			const s = joyMax / dist;
			dx *= s;
			dy *= s;
		}

		setJoyKnob(dx, dy);

		// normalize to [-1..1] for movement
		joyVec.x = dx / joyMax;
		joyVec.y = dy / joyMax;

		updateDirFromJoy();
	}

	// --- Look control on right side ---
	function beginLook(touch) {
		lookTouchId = touch.identifier;
		lookLast = touch;
	}

	function moveLook(touch) {
		if (!lookLast) return;
		orientCamera(
			touch.clientX - lookLast.clientX,
			touch.clientY - lookLast.clientY,
			touchSensibility
		);
		lookLast = touch;
	}

	// --- Touch handlers ---
	function handleTouchStart(e) {
		if (!isTouchDevice) return;

		// prevent page scroll / bounce
		e.preventDefault();

		// disable pointer lock on touch
		if (pointer) {
			pointer.destroy();
			pointer = false;
		}

		createJoystick();

		for (const t of Array.from(e.changedTouches)) {
			const x = t.clientX;
			const y = t.clientY;

			// If touch starts inside joystick -> movement
			const rect = joy.getBoundingClientRect();
			const insideJoy = (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom);

			if (insideJoy && moveTouchId === null) {
				beginJoy(t);
			} else if (!insideJoy && lookTouchId === null && x > window.innerWidth * 0.45) {
				// Prefer look on the right side (avoid stealing joystick touch)
				beginLook(t);
			}
		}
	}

	function handleTouchMove(e) {
		if (!isTouchDevice) return;
		e.preventDefault();

		const touches = Array.from(e.touches);

		if (moveTouchId !== null) {
			const t = touches.find(tt => tt.identifier === moveTouchId);
			if (t) moveJoy(t);
		}

		if (lookTouchId !== null) {
			const t = touches.find(tt => tt.identifier === lookTouchId);
			if (t) moveLook(t);
		}
	}

	function handleTouchEnd(e) {
		if (!isTouchDevice) return;
		e.preventDefault();

		for (const t of Array.from(e.changedTouches)) {
			if (moveTouchId !== null && t.identifier === moveTouchId) {
				moveTouchId = null;
				resetJoystick();
			}
			if (lookTouchId !== null && t.identifier === lookTouchId) {
				lookTouchId = null;
				lookLast = null;
			}
		}
	}

	window.addEventListener('touchstart', handleTouchStart, { passive: false });
	window.addEventListener('touchmove', handleTouchMove, { passive: false });
	window.addEventListener('touchend', handleTouchEnd, { passive: false });
	window.addEventListener('touchcancel', handleTouchEnd, { passive: false });

	// Keyboard input
	var keys = {};
	const handleKey = (e) => {
		if (e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey) return;
		keys[e.code] = e.type === 'keydown';
		run = e.shiftKey;
		const left = keys['KeyA'] || keys['ArrowLeft'] ? 1 : 0;
		const right = keys['KeyD'] || keys['ArrowRight'] ? 1 : 0;
		const up = keys['KeyW'] || keys['ArrowUp'] ? 1 : 0;
		const down = keys['KeyS'] || keys['ArrowDown'] ? 1 : 0;
		dir = [right - left, 0, down - up];
		e.preventDefault();
	};
	window.addEventListener('keydown', handleKey);
	window.addEventListener('keyup', handleKey);

	// First person scope
	var lastTime = 0;
	return {
		pos, fmouse, forward, up,
		view: () => view,
		proj: () => {
			mat4.perspective(proj, fovY(), window.innerWidth / window.innerHeight, 0.1, 100);
			return proj;
		},
		tick: ({ time }) => {
			// Delta time
			const dt = time - lastTime;
			lastTime = time;
			// Cache matrix
			//if (!rotate && dir[0] === 0 && dir[2] === 0 && walkTime === 0.25) return;
			//rotate = false;
			// Force, Up and Forward direction
			let tmp1 = [0, 0, 0], tmp2 = []; //reduce gc performance problem
			vec3.set(forward, 1, 0, 0);
			vec3.set(up, 0, 1, 0);
			vec3.rotateY(force, dir, tmp1, -mouse[1]);
			vec3.rotateY(forward, forward, tmp1, -mouse[1]);
			vec3.rotateX(forward, forward, tmp1, -mouse[0]);
			vec3.rotateX(up, up, tmp1, -mouse[0]);
			vec3.normalize(force, force);
			//console.log(forward, up);
			// Move
			const speed = (run ? runSpeed : walkSpeed);
			vec3.scale(force, force, speed * dt);
			pos[1] = height;
			const newPos = vec3.add([], pos, force);
			// Collide
			const collisions = getGridSegments(newPos[0], newPos[2])
				.map(([[ax, ay], [bx, by]]) => [[ax, height, ay], [bx, height, by]])
				.filter(([a, b]) => sdLine(newPos, a, b, tmp1, tmp2) < distToWalls);
			if (collisions.length !== 0) {
				for (let [a, b] of collisions) {
					const distance = distToWalls - sdLine(newPos, a, b, tmp1, tmp2);
					const delta = vec3.sub(tmp1, b, a).reverse();
					delta[0] = -delta[0];
					vec3.normalize(delta, delta);
					vec3.scale(delta, delta, distance);
					vec3.add(force, force, delta);
				}
			}
			// Apply walk y motion
			const d = vec3.len(force);
			if (d === 0 && walkTime !== 0.25) {
				walkTime = (Math.abs((walkTime + 0.5) % 1 - 0.5) - 0.25) * 0.8 + 0.25;
				if ((walkTime + 0.01) % 0.25 < 0.02)
					walkTime = 0.25;
			}
			const lastWalkTime = walkTime;
			walkTime += d / (run ? runStepLen : walkStepLen);
			//console.log(d / (run ? runStepLen : walkStepLen) / dt * 60);
			pos[1] = height + stepHeight * Math.cos(2 * Math.PI * walkTime);
			vec3.add(pos, pos, force);
			// Teleportation transition
			if(tpProgress < 1) {
				tpProgress += dt / tpDuration;
				tpProgress = Math.min(tpProgress, 1);
				const t = easeInOutQuad(tpProgress);
				//console.log(t, tpProgress, pos);
				vec3.set(pos, lerp(t, startPos[0], endPos[0]), pos[1],  lerp(t, startPos[2], endPos[2]));
			}
			// Filter mouse mouvement
			fmouse[0] = rotationFilter * mouse[0] + (1 - rotationFilter) * fmouse[0];
			fmouse[1] = rotationFilter * mouse[1] + (1 - rotationFilter) * fmouse[1];
			// Update view
			mat4.identity(view);
			mat4.rotateX(view, view, fmouse[0]);
			mat4.rotateY(view, view, fmouse[1]);
			mat4.translate(view, view, vec3.scale(tmp1, pos, -1));
			// Update footstep
			/*if (walkTime > 0.5)
				footstep.update(pos, force, up);
			if (lastWalkTime % 1 <= 0.5 && walkTime % 1 > 0.5)
				footstep.step([pos[0], 0, pos[2]], run);*/
			return;
		}
	};
};
