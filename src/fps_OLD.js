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

	// Touch input
		// Touch input (two-thumb controls)
	// Left thumb: movement joystick
	// Right thumb: look/swipe
	// Tap-to-teleport is disabled for mobile.

	let moveTouchId = null;
	let lookTouchId = null;

	let moveStart = null;
	let lastLookTouch = null;

	const deadZone = 8;     // px
	const maxRadius = 70;   // px (virtual joystick radius)

	const hypot = (x, y) => Math.hypot(x, y);

	const handleTouch = (e) => {
		e.preventDefault();

		// Disable pointer lock on first touch interaction
		if(pointer) {
			pointer.destroy();
			pointer = false;
		}

		const touches = Array.from(e.touches);
		const changed = Array.from(e.changedTouches || []);

		if(e.type === "touchstart") {
			for (const t of touches) {
				const isLeft = t.pageX < window.innerWidth * 0.5;

				if (isLeft && moveTouchId === null) {
					moveTouchId = t.identifier;
					moveStart = { x: t.pageX, y: t.pageY };
					// Start with no movement until user drags
					dir = [0, 0, 0];
				} else if (!isLeft && lookTouchId === null) {
					lookTouchId = t.identifier;
					lastLookTouch = t;
				}
			}
		}

		if(e.type === "touchmove") {
			// Movement joystick
			if (moveTouchId !== null && moveStart) {
				const t = touches.find(tt => tt.identifier === moveTouchId);
				if (t) {
					let dx = t.pageX - moveStart.x;
					let dy = t.pageY - moveStart.y;

					// Limit joystick radius
					const r = hypot(dx, dy);
					if (r > maxRadius) {
						dx *= maxRadius / r;
						dy *= maxRadius / r;
					}

					// Deadzone
					const rr = hypot(dx, dy);
					if (rr < deadZone) {
						dir = [0, 0, 0];
					} else {
						// Normalize to [-1, 1]
						const nx = dx / maxRadius;  // strafe
						const ny = dy / maxRadius;  // forward/back (positive = down)

						// Match existing keyboard convention:
						// dir = [right-left, 0, down-up]
						// So: nx -> x axis, ny -> z axis
						dir = [nx, 0, ny];
					}
				}
			}

			// Look control
			if (lookTouchId !== null && lastLookTouch) {
				const t = touches.find(tt => tt.identifier === lookTouchId);
				if (t) {
					orientCamera(
						t.pageX - lastLookTouch.pageX,
						t.pageY - lastLookTouch.pageY,
						touchSensibility
					);
					lastLookTouch = t;
				}
			}
		}

		if(e.type === "touchend" || e.type === "touchcancel") {
			const endedIds = new Set(changed.map(t => t.identifier));

			// If movement touch ended: stop moving
			if (moveTouchId !== null && endedIds.has(moveTouchId)) {
				moveTouchId = null;
				moveStart = null;
				dir = [0, 0, 0];
			}

			// If look touch ended: stop looking
			if (lookTouchId !== null && endedIds.has(lookTouchId)) {
				lookTouchId = null;
				lastLookTouch = null;
			}
		}
	};

	window.addEventListener('touchstart', handleTouch, {passive: false});
	window.addEventListener('touchmove', handleTouch, {passive: false});
	window.addEventListener('touchend', handleTouch, {passive: false});
	window.addEventListener('touchcancel', handleTouch, {passive: false});

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
