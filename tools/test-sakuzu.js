// Quick smoke test of sakuzu.js outside the browser.
// Run: node tools/test-sakuzu.js

const fs = require('fs');
const path = require('path');

// Stub a global window/document for the IIFE.
global.window = {};
global.document = { body: { classList: { contains: () => false } } };

const src = fs.readFileSync(path.join(__dirname, '..', 'assets', 'libs', 'sakuzu.js'), 'utf8');
eval(src);
const Sakuzu = global.window.Sakuzu;

const samples = fs.readFileSync(path.join(__dirname, '..', 'samples', 'sakuzu.md'), 'utf8');
// Extract every ```sakuzu ... ``` block.
const blocks = [];
const re = /```sakuzu\n([\s\S]*?)```/g;
let m;
while ((m = re.exec(samples)) !== null) blocks.push(m[1]);

console.log('Found ' + blocks.length + ' sakuzu blocks in samples/sakuzu.md');
let failed = 0;
blocks.forEach((b, i) => {
    try {
        const svg = Sakuzu.render(b);
        if (svg.includes('sakuzu-error')) {
            console.error('--- Block #' + (i + 1) + ' rendered an error ---');
            console.error(svg);
            console.error('--- source ---');
            console.error(b);
            failed++;
        } else {
            console.log('Block #' + (i + 1) + ': OK (' + svg.length + ' chars)');
        }
    } catch (e) {
        console.error('--- Block #' + (i + 1) + ' threw ---');
        console.error(e.message);
        console.error('--- source ---');
        console.error(b);
        failed++;
    }
});

// Verification: nine-point circle. For an arbitrary triangle, verify that
// all 9 characteristic points are equidistant from the circumcenter of the
// midpoint triangle, within numerical tolerance.
console.log('\n=== Nine-point circle numerical check ===');
function verifyNinePoint(A, B, C, label) {
    // Reuse Sakuzu by feeding it source and reading back via parse.
    // Simpler: replicate the math directly here.
    function mid(p, q) { return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }; }
    function foot(p, a, b) {
        const dx = b.x - a.x, dy = b.y - a.y;
        const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy);
        return { x: a.x + t * dx, y: a.y + t * dy };
    }
    function orthocenter(a, b, c) {
        const d1x = -(c.y - b.y), d1y = (c.x - b.x);
        const d2x = -(a.y - c.y), d2y = (a.x - c.x);
        const det = d1x * (-d2y) - d1y * (-d2x);
        const bx = b.x - a.x, by = b.y - a.y;
        const t = (bx * (-d2y) - by * (-d2x)) / det;
        return { x: a.x + t * d1x, y: a.y + t * d1y };
    }
    function circle3(p, q, r) {
        const ax = p.x, ay = p.y, bx = q.x, by = q.y, cx = r.x, cy = r.y;
        const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
        const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) +
                    (cx * cx + cy * cy) * (ay - by)) / d;
        const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) +
                    (cx * cx + cy * cy) * (bx - ax)) / d;
        const center = { x: ux, y: uy };
        const radius = Math.hypot(ax - ux, ay - uy);
        return { center, radius };
    }
    function dist(p, q) { return Math.hypot(p.x - q.x, p.y - q.y); }

    const Ma = mid(B, C), Mb = mid(C, A), Mc = mid(A, B);
    const Ha = foot(A, B, C), Hb = foot(B, C, A), Hc = foot(C, A, B);
    const H = orthocenter(A, B, C);
    const Ea = mid(H, A), Eb = mid(H, B), Ec = mid(H, C);

    const nine = circle3(Ma, Mb, Mc);
    const pts = { Ma, Mb, Mc, Ha, Hb, Hc, Ea, Eb, Ec };
    let maxErr = 0;
    for (const name in pts) {
        const d = dist(pts[name], nine.center) - nine.radius;
        if (Math.abs(d) > maxErr) maxErr = Math.abs(d);
    }
    console.log(label + ': nine-circle center=(' + nine.center.x.toFixed(4) + ', ' +
                nine.center.y.toFixed(4) + '), radius=' + nine.radius.toFixed(4) +
                ', max |dist - r| over 9 points = ' + maxErr.toExponential(3));
    if (maxErr > 1e-8) {
        console.error('  FAIL: tolerance exceeded');
        failed++;
    } else {
        console.log('  OK');
    }
}
verifyNinePoint({x:0,y:0}, {x:6,y:0}, {x:1.5,y:4.5}, 'acute');
verifyNinePoint({x:0,y:0}, {x:5,y:0}, {x:7,y:3}, 'obtuse');

// Verification: Pascal's theorem.
console.log('\n=== Pascal\'s theorem numerical check ===');
function verifyPascal(O, R, angles) {
    function pt(theta) { return { x: O.x + R * Math.cos(theta), y: O.y + R * Math.sin(theta) }; }
    function intersect(a, b) {
        const x1=a.p.x, y1=a.p.y, x2=a.q.x, y2=a.q.y;
        const x3=b.p.x, y3=b.p.y, x4=b.q.x, y4=b.q.y;
        const den = (x1-x2)*(y3-y4) - (y1-y2)*(x3-x4);
        const t = ((x1-x3)*(y3-y4) - (y1-y3)*(x3-x4)) / den;
        return { x: x1 + t*(x2-x1), y: y1 + t*(y2-y1) };
    }
    const Ps = angles.map(a => pt(a * Math.PI / 180));
    const ln = (a, b) => ({ p: a, q: b });
    const X = intersect(ln(Ps[0], Ps[1]), ln(Ps[3], Ps[4]));
    const Y = intersect(ln(Ps[1], Ps[2]), ln(Ps[4], Ps[5]));
    const Z = intersect(ln(Ps[2], Ps[3]), ln(Ps[5], Ps[0]));
    // Distance from Y to line XZ
    const dx = Z.x - X.x, dy = Z.y - X.y;
    const num = Math.abs(dy * Y.x - dx * Y.y + Z.x * X.y - Z.y * X.x);
    const den = Math.hypot(dx, dy);
    const distYtoXZ = num / den;
    console.log('angles=' + JSON.stringify(angles) + ' -> distance Y to line(XZ) = ' +
                distYtoXZ.toExponential(3));
    if (distYtoXZ > 1e-8) {
        console.error('  FAIL: tolerance exceeded');
        failed++;
    } else {
        console.log('  OK');
    }
}
// (a) convex hexagon (cyclic-order labelling)
verifyPascal({x:0,y:0}, 1, [20, 85, 170, 200, 250, 315]);
// (b) self-crossing mystic hexagram (non-cyclic labelling)
verifyPascal({x:0,y:0}, 2, [18, 205, 82, 298, 143, 340]);

console.log('\n' + (failed === 0 ? 'ALL OK' : failed + ' FAILURE(S)'));
process.exit(failed === 0 ? 0 : 1);
